# benchmark_hazma.py - equivalent Python benchmark
import time

target = 1_000_000_000
n = 0

start = time.perf_counter()
while n < target:
    n += 1
elapsed = time.perf_counter() - start

print(f"reached {n}")
print(f"elapsed: {elapsed:.3f}s")
