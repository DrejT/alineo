---
"alineo": minor
---

**Breaking:** `AgentSpec.model` is now required.

It was optional, and a spec that omitted it silently inherited Pi's own default. That meant a
run's results could not be attributed to a model afterwards — the same class of problem as an
agent reporting success without having done the work. The model an agent runs on is part of what
the agent *is*, so the spec has to name it.

A spec without `model` now fails validation with `Agent spec must have a 'model' string — name
the model this agent runs on`, alongside any other problems in the same spec. To migrate, add the
model you were relying on Pi to pick, for example `"model": "nvidia/nemotron-3-super-120b-a12b"`.

`Alineo.attach()` builds a stub spec for a sandbox it did not create; it now reads the model back
from the sandbox's own `/etc/alineo-pi.json` rather than inventing one, and reports `"unknown"`
for sandboxes created before that file existed.
