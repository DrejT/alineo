"""A character-level language model. Edit this file.

The judge (evaluate.py) calls Model(alphabet), then fit(train_text), then prob(context, ch)
for every character of held-out text: the probability of `ch` given the last <= 16 characters.
prob() must be a probability distribution over `alphabet` for every context.
"""
from collections import defaultdict


class Model:
    ORDER = 2

    def __init__(self, alphabet):
        self.alphabet = list(alphabet)
        self.counts = defaultdict(lambda: defaultdict(int))
        self.totals = defaultdict(int)

    def fit(self, text):
        n = self.ORDER
        for i in range(n, len(text)):
            ctx = text[i - n : i]
            self.counts[ctx][text[i]] += 1
            self.totals[ctx] += 1

    def prob(self, context, ch):
        ctx = context[-self.ORDER :]
        return (self.counts[ctx][ch] + 1) / (self.totals[ctx] + len(self.alphabet))
