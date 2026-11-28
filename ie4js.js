'use strict';
(function () {

const PRELUDE = `
window.onerror=function(){return true;};
(function(){
var AP=Array.prototype,SP=String.prototype,FP=Function.prototype;
if(!FP.apply){FP.apply=function(t,a){if(t==null)t=window;var k="__w95f",s=[],i,r;a=a||[];for(i=0;i<a.length;i++)s[i]="a["+i+"]";t[k]=this;r=eval("t[k]("+s.join(",")+")");t[k]=null;return r;};}
if(!FP.call){FP.call=function(t){var a=[],i;for(i=1;i<arguments.length;i++)a[a.length]=arguments[i];return this.apply(t,a);};}
if(!FP.bind){FP.bind=function(t){var f=this,b=[],i;for(i=1;i<arguments.length;i++)b[b.length]=arguments[i];return function(){var a=b.concat([]),j;for(j=0;j<arguments.length;j++)a[a.length]=arguments[j];return f.apply(t,a);};};}
if(!AP.push){AP.push=function(){for(var i=0;i<arguments.length;i++)this[this.length]=arguments[i];return this.length;};}
if(!AP.pop){AP.pop=function(){var n=this.length;if(!n)return;var v=this[n-1];this.length=n-1;return v;};}
if(!AP.shift){AP.shift=function(){var v=this[0],i;for(i=1;i<this.length;i++)this[i-1]=this[i];if(this.length)this.length--;return v;};}
if(!AP.unshift){AP.unshift=function(){var n=arguments.length,i;for(i=this.length-1;i>=0;i--)this[i+n]=this[i];for(i=0;i<n;i++)this[i]=arguments[i];return this.length;};}
if(!AP.splice){AP.splice=function(s,c){var o=[],r=[],i,n=this.length;if(s<0)s+=n;if(c===undefined)c=n-s;for(i=0;i<n;i++)o[i]=this[i];for(i=0;i<c;i++)r[i]=o[s+i];var t=[];for(i=0;i<s;i++)t[t.length]=o[i];for(i=2;i<arguments.length;i++)t[t.length]=arguments[i];for(i=s+c;i<n;i++)t[t.length]=o[i];for(i=0;i<t.length;i++)this[i]=t[i];this.length=t.length;return r;};}
AP.forEach=AP.forEach||function(f,t){for(var i=0;i<this.length;i++)if(this[i]!==undefined)f.call(t,this[i],i,this);};
AP.map=AP.map||function(f,t){var r=[];for(var i=0;i<this.length;i++)r[i]=f.call(t,this[i],i,this);return r;};
AP.filter=AP.filter||function(f,t){var r=[];for(var i=0;i<this.length;i++)if(f.call(t,this[i],i,this))r[r.length]=this[i];return r;};
AP.some=AP.some||function(f,t){for(var i=0;i<this.length;i++)if(f.call(t,this[i],i,this))return true;return false;};
AP.every=AP.every||function(f,t){for(var i=0;i<this.length;i++)if(!f.call(t,this[i],i,this))return false;return true;};
AP.find=AP.find||function(f,t){for(var i=0;i<this.length;i++)if(f.call(t,this[i],i,this))return this[i];};
AP.findIndex=AP.findIndex||function(f,t){for(var i=0;i<this.length;i++)if(f.call(t,this[i],i,this))return i;return -1;};
AP.indexOf=AP.indexOf||function(v,s){for(var i=s||0;i<this.length;i++)if(this[i]===v)return i;return -1;};
AP.includes=AP.includes||function(v){return this.indexOf(v)>=0;};
AP.reduce=AP.reduce||function(f,a){var i=0;if(arguments.length<2)a=this[i++];for(;i<this.length;i++)a=f(a,this[i],i,this);return a;};
Array.isArray=Array.isArray||function(a){return a!=null&&a.constructor==Array;};
Array.from=Array.from||function(a,f){var r=[],i;if(typeof a=="string")a=a.split("");for(i=0;i<a.length;i++)r[i]=f?f(a[i],i):a[i];return r;};
Array.of=Array.of||function(){return Array.from(arguments);};
Object.keys=Object.keys||function(o){var r=[],k;for(k in o)r[r.length]=k;return r;};
Object.assign=Object.assign||function(t){for(var i=1;i<arguments.length;i++){var s=arguments[i],k;if(s!=null)for(k in s)t[k]=s[k];}return t;};
Object.freeze=Object.freeze||function(o){return o;};
Object.create=Object.create||function(p){function F(){}F.prototype=p;return new F();};
Object.defineProperty=Object.defineProperty||function(o,k,d){if(d.value!==undefined)o[k]=d.value;else if(d.get)o[k]=d.get.call(o);return o;};
Object.getPrototypeOf=Object.getPrototypeOf||function(o){return o.constructor?o.constructor.prototype:null;};
Object.setPrototypeOf=Object.setPrototypeOf||function(o){return o;};
SP.trim=SP.trim||function(){return this.replace(/^\\s+|\\s+$/g,"");};
SP.includes=SP.includes||function(s){return this.indexOf(s)>=0;};
SP.startsWith=SP.startsWith||function(s){return this.substr(0,s.length)==s;};
SP.endsWith=SP.endsWith||function(s){return this.substr(this.length-s.length)==s;};
SP.repeat=SP.repeat||function(n){var r="";while(n-->0)r+=this;return r;};
Date.now=Date.now||function(){return new Date().getTime();};
if(typeof navigator!="undefined"&&!navigator.languages)navigator.languages=[navigator.userLanguage||navigator.browserLanguage||"en"];
if(typeof navigator!="undefined"&&!navigator.language)navigator.language=navigator.languages[0];
function all(r){return r.all||document.all;}
function list(c){var a=[],i;for(i=0;i<c.length;i++)a[i]=c[i];return a;}
function one(e,s){var m=/^([a-zA-Z0-9]*)(#[\\w-]+)?((\\.[\\w-]+)*)$/.exec(s);if(!m)return false;
 if(m[1]&&e.tagName.toLowerCase()!=m[1].toLowerCase())return false;if(m[2]&&e.id!=m[2].substr(1))return false;
 if(m[3]){var c=" "+e.className+" ",k=m[3].split(".");for(var i=1;i<k.length;i++)if(c.indexOf(" "+k[i]+" ")<0)return false;}return true;}
function match(e,s){var p=s.split(","),i;for(i=0;i<p.length;i++)if(one(e,p[i].replace(/^\\s+|\\s+$/g,"")))return true;return false;}
function qsa(r,s){var a=all(r),o=[],i;for(i=0;i<a.length;i++)if(a[i].tagName&&match(a[i],s))o[o.length]=window.__w95el(a[i]);return o;}
function html(n){return typeof n=="string"?n.replace(/&/g,"&amp;").replace(/</g,"&lt;"):n.outerHTML;}
function move(e,w,n){var h=html(n);if(typeof n!="string")n.outerHTML="";e.insertAdjacentHTML(w,h);return n;}
var S={
 querySelectorAll:qsa,
 querySelector:function(r,s){return qsa(r,s)[0]||null;},
 getElementById:function(d,i){var e=document.all[i];return e&&e.length&&!e.tagName?e[0]:e||null;},
 getElementsByTagName:function(r,t){return t=="*"?list(all(r)):list(all(r).tags(t));},
 getElementsByClassName:function(r,c){return qsa(r,"."+c.split(" ").join("."));},
 prepend:function(e,n){return move(e,"afterBegin",n);},
 append:function(e,n){return move(e,"beforeEnd",n);},
 appendChild:function(e,n){return move(e,"beforeEnd",n);},
 before:function(e,n){return move(e,"beforeBegin",n);},
 after:function(e,n){return move(e,"afterEnd",n);},
 replaceWith:function(e,n){e.outerHTML=html(n);},
 remove:function(e){e.outerHTML="";},
 insertAdjacentHTML:function(e,w,h){e.insertAdjacentHTML(w,h);},
 insertAdjacentElement:function(e,w,n){return move(e,w,n);},
 addEventListener:function(e,t,f){var o=e["on"+t];e["on"+t]=function(v){v=v||window.event;if(o)o(v);return f.call(e,v);};},
 removeEventListener:function(e,t){e["on"+t]=null;},
 matches:function(e,s){return match(e,s);},
 closest:function(e,s){while(e&&e.tagName){if(match(e,s))return e;e=e.parentElement;}return null;}
};
function nat(o,k,a){switch(a.length){case 0:return o[k]();case 1:return o[k](a[0]);case 2:return o[k](a[0],a[1]);case 3:return o[k](a[0],a[1],a[2]);default:return o[k](a[0],a[1],a[2],a[3]);}}
window.__w95throw=function(e){window.__w95err=e;return window.__w95err.__w95raise();};
window.__w95io=function(o,C){if(o==null||typeof C!="function")return false;var c=o.constructor;while(c){if(c==C)return true;c=c.__w95super;}return C==Object;};
window.__w95in=function(k,o){return o!=null&&o[k]!==undefined;};
window.__w95el=function(e){if(!e||e.__w95)return e;e.__w95=1;for(var k in S)if(typeof e[k]=="undefined")e[k]=(function(f){return function(a,b,c){return f(this,a,b,c);};})(S[k]);return e;};
window.__w95all=function(){var a=document.all,i;window.__w95el(document);for(i=0;i<a.length;i++)window.__w95el(a[i]);};
window.__w95arr=function(x){return typeof x=="string"?x.split(""):Array.from(x);};
window.__w95call=function(o,k,a){return o[k].apply(o,a);};
window.__w95dom={
 m:function(o,k,a){if(o==null||typeof o[k]!="undefined"||!S[k])return nat(o,k,a);var b=[o],i;for(i=0;i<a.length;i++)b[b.length]=a[i];switch(b.length){case 1:return S[k](b[0]);case 2:return S[k](b[0],b[1]);case 3:return S[k](b[0],b[1],b[2]);default:return S[k](b[0],b[1],b[2],b[3]);}},
 cls:function(o,k,c,f){if(o.classList)return nat(o.classList,k,f===undefined?[c]:[c,f]);var s=" "+o.className+" ",h=s.indexOf(" "+c+" ")>=0;
  if(k=="contains")return h;if(k=="toggle")k=(f===undefined?!h:f)?"add":"remove";
  if(k=="add"&&!h)o.className=(o.className?o.className+" ":"")+c;if(k=="remove"&&h)o.className=s.replace(" "+c+" "," ").replace(/^\\s+|\\s+$/g,"");return k=="add";}
};
})();
`;

const ID = /[A-Za-z0-9_$\u0080-￿]/, KEYWORD_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else']);
const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**'];
function tokens(s) {
  const out = [];
  const sig = () => { for (let k = out.length - 1; k >= 0; k--) if (out[k].t !== 'ws') return out[k]; return null; };
  let i = 0;
  while (i < s.length) {
    const c = s[i], st = i;
    if (/\s/.test(c)) { while (i < s.length && /\s/.test(s[i])) i++; out.push({ t: 'ws', v: s.slice(st, i) }); continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; out.push({ t: 'ws', v: s.slice(st, i) }); continue; }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; out.push({ t: 'ws', v: s.slice(st, i) }); continue; }
    if (c === '"' || c === "'") { i++; while (i < s.length && s[i] !== c) { if (s[i] === '\\') i++; i++; } i++; out.push({ t: 'str', v: s.slice(st, i) }); continue; }
    if (c === '`') {
      const parts = []; let lit = ''; i++;
      while (i < s.length && s[i] !== '`') {
        if (s[i] === '\\') { lit += s[i] + s[i + 1]; i += 2; continue; }
        if (s[i] === '$' && s[i + 1] === '{') {
          parts.push({ lit }); lit = ''; i += 2; let d = 1; const es = i;
          while (i < s.length && d) { const t = tokens(s.slice(i, i + 1)); if (s[i] === '{') d++; else if (s[i] === '}') d--; else if (s[i] === '`' || s[i] === '"' || s[i] === "'") { const q = tokens(s.slice(i)); i += q[0].v.length; continue; } i++; void t; }
          parts.push({ expr: s.slice(es, i - 1) }); continue;
        }
        lit += s[i++];
      }
      i++; parts.push({ lit }); out.push({ t: 'tmpl', v: s.slice(st, i), parts }); continue;
    }
    if (ID.test(c)) { while (i < s.length && ID.test(s[i])) i++; const v = s.slice(st, i); out.push({ t: /^[0-9]/.test(v) ? 'num' : 'id', v }); continue; }
    if (c === '/') {
      const p = sig();
      if (!p || (p.t === 'punct' && !/^[)\]}]$/.test(p.v)) || (p.t === 'id' && KEYWORD_BEFORE_REGEX.has(p.v))) {
        i++; let cls = false;
        while (i < s.length && (s[i] !== '/' || cls)) { if (s[i] === '\\') i++; else if (s[i] === '[') cls = true; else if (s[i] === ']') cls = false; i++; }
        i++; while (i < s.length && /[a-z]/i.test(s[i])) i++;
        out.push({ t: 'regex', v: s.slice(st, i) }); continue;
      }
    }
    if (c === '.' && /[0-9]/.test(s[i + 1] || '')) { i++; while (i < s.length && ID.test(s[i])) i++; out.push({ t: 'num', v: s.slice(st, i) }); continue; }
    const p = PUNCT.find(x => s.startsWith(x, i)) || c;
    i += p.length; out.push({ t: 'punct', v: p });
  }
  return out;
}
const OPEN = { '(': ')', '[': ']', '{': '}' }, CLOSE = { ')': '(', ']': '[', '}': '{' };
const isP = (t, v) => t && t.t === 'punct' && t.v === v;
const join = ts => ts.map(t => t.v).join('');
function next(ts, i) { while (i < ts.length && ts[i].t === 'ws') i++; return i; }
function prev(ts, i) { while (i >= 0 && ts[i].t === 'ws') i--; return i; }
function match(ts, i) {
  const o = ts[i].v, c = OPEN[o]; let d = 0;
  for (let k = i; k < ts.length; k++) { if (isP(ts[k], o)) d++; else if (isP(ts[k], c) && --d === 0) return k; }
  return ts.length - 1;
}
function matchBack(ts, i) {
  const c = ts[i].v, o = CLOSE[c]; let d = 0;
  for (let k = i; k >= 0; k--) { if (isP(ts[k], c)) d++; else if (isP(ts[k], o) && --d === 0) return k; }
  return 0;
}
function exprEnd(ts, i) {
  let d = 0;
  for (let k = i; k < ts.length; k++) {
    const t = ts[k];
    if (t.t !== 'punct') continue;
    if (OPEN[t.v]) d++;
    else if (CLOSE[t.v]) { if (d === 0) return k; d--; }
    else if (d === 0 && (t.v === ',' || t.v === ';')) return k;
  }
  return ts.length;
}
function splitTop(ts) {
  const parts = []; let d = 0, cur = [];
  for (const t of ts) {
    if (t.t === 'punct' && OPEN[t.v]) d++; else if (t.t === 'punct' && CLOSE[t.v]) d--;
    if (d === 0 && isP(t, ',')) { parts.push(cur); cur = []; } else cur.push(t);
  }
  if (cur.some(t => t.t !== 'ws')) parts.push(cur);
  return parts;
}
function spreadList(items) {
  return '[].concat(' + items.map(p => { const k = next(p, 0); return isP(p[k], '...') ? `window.__w95arr(${es5(join(p.slice(k + 1)))})` : `[${es5(join(p))}]`; }).join(',') + ')';
}
const replace = (ts, a, b, s) => { ts.splice(a, b - a + 1, ...tokens(s)); };
function es5(src) {
  const ts = tokens(src);
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (t.t === 'tmpl') {
      const p = prev(ts, i - 1);
      if (p >= 0 && (ts[p].t === 'id' || isP(ts[p], ')') || isP(ts[p], ']')) && !KEYWORD_BEFORE_REGEX.has(ts[p].v)) continue;
      const s = '(' + t.parts.map(x => 'lit' in x ? JSON.stringify(x.lit.replace(/\\`/g, '`').replace(/\\\$/g, '$')) : `(${es5(x.expr)})`).join('+') + ')';
      ts[i] = { t: 'raw', v: s };
    } else if (t.t === 'id' && (t.v === 'const' || t.v === 'let')) {
      const n = ts[next(ts, i + 1)];
      if (t.v === 'const' || (n && (n.t === 'id' || isP(n, '[') || isP(n, '{')))) t.v = 'var';
    }
  }
  for (let i = ts.length - 1; i >= 0; i--) {
    if (!isP(ts[i], '=>')) continue;
    const p = prev(ts, i - 1); let a, params;
    if (isP(ts[p], ')')) { a = matchBack(ts, p); params = join(ts.slice(a + 1, p)); }
    else { a = p; params = ts[p].v; }
    const pa = prev(ts, a - 1); if (pa >= 0 && ts[pa].t === 'id' && ts[pa].v === 'async') a = pa;
    const b = next(ts, i + 1);
    if (isP(ts[b], '{')) { const e = match(ts, b); replace(ts, a, e, `function(${params})${join(ts.slice(b, e + 1))}`); }
    else { const e = exprEnd(ts, b); replace(ts, a, e - 1, `function(${params}){return ${join(ts.slice(b, e))};}`); }
    i = a;
  }
  for (let i = ts.length - 1; i >= 0; i--) {
    if (!isP(ts[i], '[') && !isP(ts[i], '(')) continue;
    const e = match(ts, i), inner = ts.slice(i + 1, e), items = splitTop(inner);
    if (!items.some(p => isP(p[next(p, 0)], '...'))) continue;
    const list = spreadList(items);
    if (isP(ts[i], '[')) {
      const p = prev(ts, i - 1);
      if (p >= 0 && (ts[p].t === 'id' && !KEYWORD_BEFORE_REGEX.has(ts[p].v) || isP(ts[p], ')') || isP(ts[p], ']'))) continue;
      replace(ts, i, e, list); continue;
    }
    let c = prev(ts, i - 1);
    if (c < 0 || !(ts[c].t === 'id' || isP(ts[c], ')') || isP(ts[c], ']'))) continue;
    let s = c;
    for (;;) {
      if (isP(ts[s], ')') || isP(ts[s], ']')) s = matchBack(ts, s);
      const q = prev(ts, s - 1);
      if (q >= 0 && (isP(ts[q], '.') || isP(ts[q], '?.'))) { s = prev(ts, q - 1); continue; }
      if (q >= 0 && isP(ts[s], '[')) { s = q; continue; }
      break;
    }
    const callee = ts.slice(s, c + 1), dot = callee.map((t, k) => isP(t, '.') ? k : -1).filter(k => k >= 0).pop();
    const call = dot === undefined ? `${join(callee)}.apply(null,${list})` : `window.__w95call(${join(callee.slice(0, dot))},${JSON.stringify(join(callee.slice(dot + 1)).trim())},${list})`;
    replace(ts, s, e, call); i = s;
  }
  return join(ts);
}
const ascii = s => s.replace(/[\u0080-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
function script(src) { return ascii(es5(src)); }

function html(text) {
  const conv = text.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (all, attrs, code) => {
    if (/\bsrc\s*=/i.test(attrs)) return /\bdefer\b/i.test(attrs) ? all : `<script defer${attrs}>${code}</script>`;
    if (/type\s*=\s*["']?(?!text\/javascript|application\/javascript)[^"'\s>]+/i.test(attrs) || !code.trim()) return all;
    return `<script${attrs}>${script(code)}</script>`;
  });
  const pre = `<script>${PRELUDE}</script>`, post = '<script>window.__w95all();</script>';
  const h = /<head\b[^>]*>/i.exec(conv), withPre = h ? conv.slice(0, h.index + h[0].length) + pre + conv.slice(h.index + h[0].length) : pre + conv;
  const b = withPre.search(/<\/body>/i);
  return b >= 0 ? withPre.slice(0, b) + post + withPre.slice(b) : withPre + post;
}

self.W95IE4JS = { html, script, es5, PRELUDE };
})();
