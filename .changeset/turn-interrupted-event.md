---
"@alineo-labs/schema": minor
---

New alineod control-plane event: `agent.turn_interrupted`. Emitted when alineod finds an agent
still `running` on boot — its turn died with the previous process — before the catch-up poll that
follows. A crash-interrupted turn now carries a durable record distinct from one that ran
straight through, whatever catch-up later finds (durability-roadmap.md M1.2).
