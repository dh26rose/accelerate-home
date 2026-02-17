# Architecture Decision: Feature Flag System for Gradual Rollout

## Business Context Summary

- **10,000 schools** using the platform.
- Need **gradual rollouts** (e.g., 5% → 25% → 100%).
- **Instant disable** required if bugs are found.
- Schools belong to different **subscription tiers** (basic, premium, enterprise).
- Some features are **tier‑restricted**.
- **A/B testing** with specific schools is a product requirement.
- Current solution (environment variables + manual deploys) **does not scale**.

---

## Section 1: Solution Approaches

### Approach 1: Configuration File–Based System

**Description**  
Flags stored in version‑controlled YAML/JSON files. The application reads them at startup or on a config‑server refresh. Changes require a new deployment or a config reload.

**Architecture Overview**  
- A single file (or set of files) per environment defines flag keys and default values.  
- App loads the file on start; optional file‑watcher or polling from a config server.  
- No runtime database; evaluation is in‑process.

**Pros**  
- **Simple** – no new infrastructure, low maintenance.  
- **Versioned** with code – rollbacks are a single git revert.  
- **Fast** – zero network latency, works offline.  
- **Zero cost**.

**Cons**  
- **No instant toggles** – changes require deploy or config‑server refresh.  
- **No fine‑grained targeting** – cannot enable per school or per tier without huge config files.  
- **Gradual rollout is awkward** – would need external logic or multiple deploys.  
- **A/B testing impractical** – no way to assign variants dynamically.

**Complexity** – Low

**Example**  
Roll out a new “Assignments UI” by setting `assignments_v2: true` in production config and deploying. To disable, set to `false` and redeploy. Works only when all schools get the same value.

---

### Approach 2: Database-Driven Feature Flags

**Description**  
Flags and targeting rules are stored in a relational database. An admin API/UI allows instant changes. The application evaluates flags using a cached read path for low latency.

**Architecture Overview**  
- Tables: `features` (id, key, description, default_state), `feature_overrides` (feature_id, school_id, enabled), `feature_targeting` (feature_id, rule_type, rule_value, priority).  
- App (or a dedicated service) queries a **Redis cache** (TTL 30–60s) which is populated from the DB.  
- On flag update, invalidate cache entries (e.g., via Redis pub/sub).  
- SDK/middleware in app evaluates targeting rules (tier, percentage, school ID) and returns boolean.

**Pros**  
- **Instant toggles** – change flag in DB, propagate via cache invalidation (seconds).  
- **Fine‑grained targeting** – by school ID, tier, percentage rollout, A/B cohorts.  
- **Scalable** – DB + Redis handles 10k schools and frequent reads.  
- **No vendor lock‑in, lower long‑term cost** compared to third‑party services.  

**Cons**  
- **Requires building and maintaining** the admin UI, caching, and fallback logic.  
- **Cache staleness** – changes may take up to TTL seconds unless invalidation is implemented.  
- **DB/cache failure** must be handled gracefully (fallback to env vars or last‑known config).  

**Complexity** – Medium

**Example**  
Enable “Grade export” only for premium and enterprise tiers. Product adds a targeting rule in the DB. App middleware evaluates `flags.gradeExport(school.tier)` – within seconds after cache invalidation, premium schools see the feature. If a bug is found, set the flag to `false` in the DB, invalidate cache, and all schools lose the feature instantly.

---

### Approach 3: Third-Party Feature Flag Service (e.g., LaunchDarkly)

**Description**  
A managed vendor provides the flag store, targeting UI, and SDKs. The application integrates the SDK and evaluates flags via the vendor’s API (with local caching).

**Architecture Overview**  
- App embeds SDK (e.g., LaunchDarkly).  
- SDK initializes, downloads flag rules, and streams updates.  
- Evaluation is local (cached) after initial download.  
- Vendor UI handles targeting, percentage rollouts, and analytics.

**Pros**  
- **Zero internal development** – ready in hours.  
- **Rich targeting** – percentage, segments, A/B testing, gradual rollout built‑in.  
- **Instant changes** via UI; SDK receives updates in near‑real‑time.  
- **Analytics** – built‑in dashboards for feature usage.

**Cons**  
- **Ongoing cost** – can be significant for 10k schools and many flags.  
- **Vendor lock‑in** – migration to another system is non‑trivial.  
- **Data residency/compliance** – flag data leaves your infrastructure.  
- **Dependency on vendor availability** – though most offer robust SLAs.

**Complexity** – Medium (integration)

**Example**  
Roll out “New assignment UI” to 5% of schools via LaunchDarkly’s percentage rollout. Product increases the percentage in UI; SDKs stream the update, and within seconds the new percentage is active globally. To disable, set flag to `false` in UI.

---

### Comparison Matrix

| Criteria                        | Config File | Database‑Driven | Third‑Party |
|---------------------------------|-------------|------------------|-------------|
| Instant toggles                 | ❌          | ✅ (with cache invalidation) | ✅ |
| Tier‑based targeting            | ❌          | ✅               | ✅ |
| Gradual rollout (% of schools)  | ❌          | ✅               | ✅ |
| A/B testing support             | ❌          | ✅ (requires design) | ✅ (built‑in) |
| Operational overhead            | Low         | Medium           | Low (ops), High (cost) |
| Cost                            | $0          | Infrastructure only | $$ per MAU |
| Time to implement               | Hours       | Weeks            | Days        |

---

## Section 2: Detailed Recommendation

### Recommended Approach: Database‑Driven Feature Flags (with Redis Cache)

**Why?**  
For 10,000 schools and the need for **gradual rollouts, instant disable, and tier‑based access**, a database‑driven system hits the sweet spot. It gives us **full control** over our data and rules without the recurring cost of a third‑party service. The team can **incrementally build** the system—starting with a simple flag table and a basic admin panel, then adding targeting rules and A/B support over time. Our engineers are already comfortable with Postgres and Redis, so the learning curve is shallow. Compared to config files, this approach meets all business requirements; compared to third‑party, it saves significant long‑term expense and keeps sensitive flag data inside our infrastructure.

### Implementation Plan (8 Steps)

1. **Define flag schema and evaluation contract**  
   - Tables: `flags`, `flag_overrides`, `flag_rules`.  
   - App interface: `getFlag(key: string, context: { schoolId, tier }): boolean`.

2. **Build a minimal flag service**  
   - A simple HTTP API or in‑process module that reads from DB and caches in‑memory with a 30‑second TTL.  
   - Expose endpoints for internal apps (admin panel) to update flags.

3. **Add a Redis cache layer**  
   - Cache flag evaluations per key + context (e.g., `flag:new_ui:school_123`).  
   - Set TTL = 30s, but also **invalidate** on flag updates via Redis pub/sub.

4. **Create an admin UI (or API) for flag management**  
   - Allow toggling flags, setting overrides per school, and defining tier‑based rules.  
   - Include audit logging (who changed what, when).

5. **Implement targeting rules evaluator**  
   - Support percentage rollouts using consistent hashing on school ID.  
   - Support tier lists (basic/premium/enterprise).  
   - Support explicit allow/block lists per school.

6. **Migrate existing environment‑variable toggles**  
   - For each env var used as a flag, create a corresponding entry in the `flags` table.  
   - Replace code like `process.env.FEATURE_X === 'true'` with a call to the flag service.  
   - Keep env var as a **fallback** (e.g., `getFlag() ?? process.env.FEATURE_X`) during transition and for outage scenarios.

7. **Documentation and runbooks**  
   - Write a short guide: “How to add a flag”, “How to perform a gradual rollout”, “Emergency disable procedure”.  
   - Provide code examples for frontend and backend flag checks.

8. **Monitoring and alerts**  
   - Metrics: flag evaluation latency, cache hit ratio, flag service uptime.  
   - Alerts if cache miss rate spikes or if the flag service is unreachable (so fallback activates).

### Risk Mitigation

| Risk                                      | Mitigation Strategy |
|-------------------------------------------|----------------------|
| **Flag service/DB outage**                | Fallback to environment variables (or last‑known cached values) with default‑off for new features. Log that fallback is active. |
| **Stale cache after flag change**         | Use short TTL (30s) and implement cache invalidation via Redis pub/sub or a version key. |
| **Misconfiguration (e.g., flag left on)** | Default all new flags to `false`; require a second pair of eyes for changes in admin UI; audit logs to track who made changes. |
| **Performance degradation**                | Index DB tables on `(key, school_id)`; use Redis for most reads; consider a local in‑memory cache (Caffeine‑like) for extreme scale. |
| **Incorrect targeting logic**              | Unit‑test the evaluator thoroughly; expose a debug endpoint to show evaluated flags for a given school. |

### Success Metrics

- **p95 evaluation latency** < 5ms (cached), < 50ms (cache miss).  
- **Cache hit rate** > 99%.  
- **Time from flag change to global effect** < 60 seconds (p99).  
- **Flag service uptime** > 99.9% (excluding planned maintenance).  
- **Number of incidents caused by misconfigured flags** – trend toward zero.  
- **Deployment frequency** – increase (since we can decouple feature releases from code deploys).  

---

## Section 3: Team and Operational Considerations

### Team Impact

- **Workflow change**: Engineers will add flags in the admin UI (or via code‑defined flags synced to DB) and use the flag service in their code. They’ll need to test with overrides (e.g., query parameters or test‑school IDs).  
- **Documentation**: A concise “Feature Flag User Guide” will cover how to create, use, and clean up flags, plus how to perform gradual rollouts and A/B tests.  
- **Training**: A 30‑minute brown‑bag session can introduce the system and demonstrate common workflows.

### Production Operations

**Debugging issues with feature flags**  
- Provide an internal **debug endpoint** (e.g., `GET /debug/flags?schoolId=123`) that returns all evaluated flags for that school, along with the rule that determined each value.  
- Log flag evaluations at debug level (with sampling to avoid volume) so we can trace decisions.  
- Admin UI should show flag history and audit log.

**What happens if the feature flag service goes down?**  
- The flag service itself (the API that reads from DB/Redis) may fail. To handle this:  
  - The SDK/middleware in the app should **fail closed** – i.e., return a safe default (usually `false` for new features) and log that it’s operating in fallback mode.  
  - It can also fall back to a **local JSON file** that is periodically downloaded from the flag service (or simply read from environment variables).  
  - Alert on‑call immediately when fallback is triggered.

**Rollback scenarios**  
- **For a single flag**: Use admin UI to toggle it off; cache invalidation ensures effect within seconds.  
- **For a catastrophic failure** (multiple flags need to be disabled): Have a **global kill switch** – a special flag that, when `true`, forces all non‑critical features to `false`. This can be a simple environment variable override.  
- **If the entire flag system is broken**, revert to environment variables (which are still present) as the ultimate fallback, and deploy a code rollback if necessary.

---

## Appendix: Sample Database Schema (PostgreSQL)

```sql
CREATE TABLE flags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    default_value BOOLEAN NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE flag_overrides (
    flag_id UUID REFERENCES flags(id) ON DELETE CASCADE,
    school_id INTEGER NOT NULL,   -- references schools table
    enabled BOOLEAN NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (flag_id, school_id)
);

CREATE TABLE flag_targeting_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    flag_id UUID REFERENCES flags(id) ON DELETE CASCADE,
    rule_type VARCHAR(50) NOT NULL,  -- 'tier', 'percentage', 'school_ids'
    rule_value JSONB NOT NULL,       -- e.g., {"tiers": ["premium", "enterprise"]} or {"percentage": 25}
    priority INTEGER DEFAULT 0,      -- lower number = higher priority
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_flag_overrides_school ON flag_overrides(school_id);
CREATE INDEX idx_flag_targeting_flag ON flag_targeting_rules(flag_id);