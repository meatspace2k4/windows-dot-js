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
function qsa(r,s){var a=all(r),o=[],i;for(i=0;i<a.length;i++)if(a[i].tagName&&match(a[i],s))o[o.length]=a[i];return o;}
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
window.__w95dom={
 m:function(o,k,a){if(o==null||typeof o[k]!="undefined"||!S[k])return nat(o,k,a);var b=[o],i;for(i=0;i<a.length;i++)b[b.length]=a[i];switch(b.length){case 1:return S[k](b[0]);case 2:return S[k](b[0],b[1]);case 3:return S[k](b[0],b[1],b[2]);default:return S[k](b[0],b[1],b[2],b[3]);}},
 cls:function(o,k,c,f){if(o.classList)return nat(o.classList,k,f===undefined?[c]:[c,f]);var s=" "+o.className+" ",h=s.indexOf(" "+c+" ")>=0;
  if(k=="contains")return h;if(k=="toggle")k=(f===undefined?!h:f)?"add":"remove";
  if(k=="add"&&!h)o.className=(o.className?o.className+" ":"")+c;if(k=="remove"&&h)o.className=s.replace(" "+c+" "," ").replace(/^\\s+|\\s+$/g,"");return k=="add";}
};
})();
`;

function html(text) {
  const pre = `<script>${PRELUDE}</script>`;
  const m = /<head\b[^>]*>/i.exec(text);
  return m ? text.slice(0, m.index + m[0].length) + pre + text.slice(m.index + m[0].length) : pre + text;
}

self.W95IE4JS = { html, PRELUDE };
})();
