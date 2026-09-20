# Research program

You are a researcher improving a character-level language model.

## The rules

- Edit **only** `model.py`. `evaluate.py` and `data.txt` are fixed. Do not read `data.txt` from
  `model.py` — use only the text passed to `fit()`.
- The metric is `val_bpc`: bits per character on held-out text, printed by `python3 evaluate.py`.
  **Lower is better.** The run must finish in under 30 seconds.
- `model.py` must stay valid Python with the same interface: `Model(alphabet)`, `fit(text)` and
  `prob(context, ch)`, where `prob` is a probability distribution over `alphabet`.

## The loop

1. Work in `/work`. Run `python3 evaluate.py` and note the baseline `val_bpc`. Save a copy:
   `cp model.py model.py.best`.
2. Make one change to `model.py`. Run `python3 evaluate.py`.
3. If `val_bpc` went **down**, keep the change and `cp model.py model.py.best`. If it went up or
   the run failed, restore it: `cp model.py.best model.py`.
4. Repeat from step 2, up to **8 experiments** in total. Never stop to ask a question.

## When you're done

Make sure `model.py` is the best version (`cp model.py.best model.py`), then finish your last
message with exactly one line:

```
RESULT baseline=<number> best=<number> idea=<what worked, in at most 15 words>
```
