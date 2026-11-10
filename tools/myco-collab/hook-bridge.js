// aop plugin hook bridge — claude hooks → aop(canvas) 协作服务
// settings.json 里：node <collab>/hook-bridge.js <EventName>
// 防御：Windows 下 claude 的 hook stdin 不总发 'end'（试点实测卡 600s）——静默 300ms 即处理。
const ev = process.argv[2] || 'Unknown';
const hub = process.env.MYCO_COLLAB_HUB || 'http://127.0.0.1:3002';

let buf = '';
let timer = null;
let done = false;

const finish = async () => {
  if (done) return;
  done = true;
  try {
    const r = await fetch(`${hub}/api/collab/hook/${ev}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: (() => {
        // AOP_TASK 附加（2026-09-08 同 cwd 并发串台根修）：hook payload 只有
        // cwd——同项目多任务时 cwd 归一键被后 spawn 覆盖,claude 的锚曾绑到
        // zcode 任务上。boot 注入的 AOP_TASK env 是任务身份权威。
        try {
          const j = JSON.parse(buf || '{}');
          if (process.env.AOP_TASK) j.aopTask = process.env.AOP_TASK;
          return JSON.stringify(j);
        } catch { return buf || '{}'; }
      })(),
    });
    const out = await r.json().catch(() => ({ exitCode: 0 }));
    if (out.stdout) process.stdout.write(out.stdout);
    if (out.stderr) process.stderr.write(out.stderr);
    process.exit(out.exitCode ?? 0);
  } catch (e) {
    process.stderr.write(`aop bridge ${ev}: hub unreachable (${e.message})`);
    process.exit(0);
  }
};

process.stdin.on('data', (c) => {
  buf += c;
  if (timer) clearTimeout(timer);
  timer = setTimeout(finish, 300);
});
setTimeout(finish, 1500);
process.stdin.on('end', finish);
