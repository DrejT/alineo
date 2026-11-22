"""The judge. Do not edit.

Trains model.Model on the first 80% of data.txt, then scores it on the remaining 20%: the average
number of bits it needs per character (val_bpc, lower is better). Refuses a model whose
probabilities don't form a distribution, and one that takes longer than TIME_LIMIT_S.
"""
import math
import os
import random
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
CONTEXT = 16  # characters of history the model is given
TIME_LIMIT_S = 30

text = open(os.path.join(HERE, "data.txt"), encoding="utf-8").read()
alphabet = sorted(set(text))
cut = int(len(text) * 0.8)
train, val = text[:cut], text[cut:]

start = time.time()
import model  # noqa: E402

m = model.Model(alphabet)
m.fit(train)

# A real distribution sums to 1 over the alphabet. Check it at a sample of positions.
rng = random.Random(0)
for i in rng.sample(range(cut, len(text)), 60):
    ctx = text[max(0, i - CONTEXT) : i]
    total = sum(m.prob(ctx, c) for c in alphabet)
    if abs(total - 1.0) > 1e-3:
        sys.exit(f"invalid: probabilities sum to {total:.4f}, not 1")

bits = 0.0
for i in range(cut, len(text)):
    p = m.prob(text[max(0, i - CONTEXT) : i], text[i])
    if not p > 0:
        sys.exit("invalid: zero or negative probability")
    bits -= math.log2(p)
seconds = time.time() - start
if seconds > TIME_LIMIT_S:
    sys.exit(f"too slow: {seconds:.1f}s (limit {TIME_LIMIT_S}s)")
print(f"val_bpc: {bits / len(val):.4f}")
print(f"seconds: {seconds:.1f}")
