# PBKDF2 benchmark

Answers PLAN.md section 5's open question: how many PBKDF2-SHA256 iterations fit
in a Worker invocation.

`Date.now()` cannot measure this. It does not advance during synchronous
execution in Workers, so the worker reports `dateNowDelta: 0` no matter how much
work it does. The real number comes from `wrangler tail`, which reports `cpuTime`
per invocation.

```bash
cd test/bench
npx wrangler deploy
npx wrangler tail --format json > tail.json &

B=https://tsundoku-bench.<your-subdomain>.workers.dev
for n in 1000 10000 50000 100000 200000; do curl -s "$B/?mode=pbkdf2&iters=$n"; done
curl -s "$B/?mode=hmac&reps=50"

# then read cpuTime out of tail.json, and clean up:
npx wrangler delete --name tsundoku-bench
```

Results are in the main README under [Security](../../README.md#security).
