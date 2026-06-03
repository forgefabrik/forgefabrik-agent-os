# Review Agent Checklist

**This is the detailed checklist for REVIEW agents.**

Reference: [AGENTS.md](../../AGENTS.md)

---

## Architecture (Section 7.1)

- [ ] No cross-layer violations
- [ ] No circular dependencies (check `cargo tree`)
- [ ] No hidden globals (thread-local, static mut, etc.)
- [ ] Phase gate rules respected (check task scope and authoritative project docs)
- [ ] Task exists in [.task-locks/registry.json](../../.task-locks/registry.json)
- [ ] RFC approved (if any architecture change)
- [ ] All `unsafe` code is documented with `// SAFETY:` comment

---

## Performance (Section 7.2)

- [ ] No unnecessary allocations (Vec, String, Box without reason)
- [ ] Cache-friendly code (contiguous memory, cache line awareness)
- [ ] No excessive cloning (Arc/Rc usage justified)
- [ ] Benchmark acceptable (if performance-critical code)
- [ ] No per-frame allocations in engine systems (<100 bytes/frame target)

---

## Safety (Section 7.3)

- [ ] Minimal `unsafe` usage
- [ ] All `unsafe` blocks have `// SAFETY: <explanation>` comment
- [ ] Send/Sync trait correctness verified
- [ ] No data races possible
- [ ] Determinism verified (no unseeded RNG, no system time in game logic)

---

## Testing (Section 7.5)

- [ ] Unit tests included
- [ ] Edge cases covered (empty, single, many)
- [ ] Determinism tests (if RNG-dependent: `ChaCha8Rng::seed_from_u64` + same output assertion)
- [ ] Property tests (quickcheck) for state machines
- [ ] All tests pass: `cargo test`

---

## Documentation

- [ ] `docs/ROADMAP.md` matches `.task-locks/registry.json` projection
- [ ] `docs/ARCHITECTURE_PRINCIPLES.md` updated when stable architecture principles changed
- [ ] `.agents/docs/` updated when agent workflow, review, ownership, or contribution protocol changed
- [ ] Documentation remains descriptive or generated only; no Markdown file is used as transition authority

---

## Code Style (Section 7.4)

- [ ] `cargo fmt --check` passes
- [ ] `cargo clippy -- -D warnings` passes
- [ ] Naming consistent (no abbreviated variables)
- [ ] Public APIs have doc comments
- [ ] Commit messages follow format: `[type] scope: msg (TASK-XXXX)`
- [ ] Branch name format: `feat|refactor|review/TASK-XXXX-description`

---

## Decision

**Verdict:**
- [ ] **APPROVED** — All checks passed
- [ ] **REJECTED** — Issues found (cite AGENTS.md rules)
- [ ] **NEEDS_REFACTOR** — Minor cleanup needed, resubmit
- [ ] **NEEDS_RFC** — Architecture change requires RFC approval

**Comments:**
[Detailed notes on any issues]

**Signed by:** [Review Agent Name]  
**Model:** Claude 3.5 Sonnet | GPT-4 Turbo
