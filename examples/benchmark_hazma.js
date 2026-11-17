// benchmark_hazma.js - equivalent JavaScript benchmark
const target = 1_000_000_000;
let n = 0;

const start = process.hrtime.bigint();
while (n < target) {
  n += 1;
}
const end = process.hrtime.bigint();
const elapsed = Number(end - start) / 1e9;

console.log(`reached ${n}`);
console.log(`elapsed: ${elapsed.toFixed(3)}s`);
