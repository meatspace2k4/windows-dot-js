// A recorded console snippet (top-level await, value of the last expression) as an async function body that
// returns that value. The split point is found by compiling candidates with V8 (nothing is run).
import vm from 'node:vm';
const ok = src => { try { new vm.Script(src); return true; } catch (_) { return false; } };
const fn = body => `(async () => {\n${body}\n})`;
export function asyncBody(code) {
  const c = code.replace(/\s+$/, '').replace(/;+$/, '');
  const cuts = [0]; for (let i = 0; i < c.length; i++) if (c[i] === '\n' || c[i] === ';' || c[i] === '}') cuts.push(i + 1);
  for (let k = cuts.length - 1; k >= 0; k--) {
    const head = c.slice(0, cuts[k]), tail = c.slice(cuts[k]).trim();
    if (!tail || /^(const|let|var|function|class|if|for|while|do|switch|try|return|throw|import|export)\b/.test(tail)) continue;
    const body = `${head}\nreturn (\n${tail}\n);`;
    if (ok(fn(body))) return body;
  }
  return ok(fn(c)) ? c : null;   // no final expression: statements only
}
if (process.argv[2] === '--check') {
  const steps = JSON.parse((await import('node:fs')).readFileSync(process.argv[3], 'utf8')).filter(s => s.kind === 'eval');
  let ret = 0, stm = 0, bad = 0; for (const s of steps) { const b = asyncBody(s.code); if (b === null) bad++; else if (b.endsWith(');') && b.includes('\nreturn (\n')) ret++; else stm++; }
  console.log({ evals: steps.length, returnsValue: ret, statementsOnly: stm, unparsable: bad });
}
