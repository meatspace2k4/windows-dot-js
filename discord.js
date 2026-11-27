// Windows 95 as a Discord Activity: the page in Discord's frame (a voice channel's Activity) joins the session of that
// Activity's instance, as the person Discord says is there. The handshake is ~/kkfm-jukebox's (browser/discord-shell.js):
// the Embedded App SDK made with the application's id, ready(), authorize (scope identify) for a code, the code
// exchanged for an access token by this page's server (tools/discord_api.py: the client secret stays there), then
// authenticate, which answers with the person.
//
// Nothing of the session's logistics is replaced: shared.js runs the session as before, on the same server
// (tools/sessions.py). This only says which session and as whom. The session is the Activity's instance id, which
// everyone in the same Activity has: it is on the frame's URL, so it is known at once, and Windows never waits for
// Discord to start. Everyone starts as Guest there.
//
// The name is asked for only when the person chooses to give it: once Windows has started, an Authorize button is on
// the screen (a stand-in drawn by the page for now, not yet a control of Windows' own), and pressing it runs the
// handshake, where Discord shows its own form the first time. The person then takes their name in the running session
// (shared.js rename: the others see the name change): their Discord display name, or their user name when the display
// name has letters a logon name cannot keep. A handshake that fails leaves them Guest, and the button to press again.
// (Discord answers the SDK's handshake once for a frame: a page loaded again in the same frame gets no answer, so the
// SDK is made once here, and a reloaded page's button waits until the Activity is started again.)
//
// The SDK is imported only in Discord's frame (its launch parameters on the URL: frame_id, instance_id, platform), from
// this origin (vendor/embedded-app-sdk.js: Discord's frame loads nothing from another origin), so a page anywhere else
// never asks for it.
(() => {
  const q = new URLSearchParams(location.search);
  const inside = q.has('frame_id');
  let sdk = null, who = null, connected = null, asking = null;

  // the instance's id as a session's id (shared.js sessionId's letters, 64 at most): its own text when that fits, as
  // Discord's do (i-<launch>-gc-<guild>-<channel>); a longer one keeps its start and a sum of the whole
  const session = id => {
    const s = String(id || '').replace(/[^A-Za-z0-9_.-]/g, '');
    if (s.length <= 64) return s;
    let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return s.slice(0, 55) + '-' + h.toString(16).padStart(8, '0');
  };

  // the application's id: on the launch URL if Discord passes it, else the server's (its configuration, not the source)
  const clientId = async () => {
    const fromUrl = q.get('client_id'); if (fromUrl) return fromUrl;
    try { const r = await fetch('__discord/config'); if (r.ok) return (await r.json()).client_id || ''; } catch (_) { /* no server */ }
    return '';
  };
  // the SDK, made and answered by Discord's client once for this page
  const connect = () => connected || (connected = (async () => {
    const id = await clientId();
    if (!id) throw new Error('no Discord application id (W95_DISCORD_CLIENT_ID on the server)');
    const { DiscordSDK } = await import('./vendor/embedded-app-sdk.js');
    // (the SDK would send every console line to Discord's client: this page's machines say a lot)
    sdk = new DiscordSDK(id, { disableConsoleLogOverride: true });
    await sdk.ready();
    return id;
  })().catch(e => { connected = null; throw e; }));

  async function handshake() {
    const id = await connect();
    const { code } = await sdk.commands.authorize({ client_id: id, response_type: 'code', state: '', prompt: 'none', scope: ['identify'] });
    const r = await fetch('__discord/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    if (!r.ok) throw new Error(`the token exchange failed (HTTP ${r.status})`);
    const { access_token } = await r.json();
    if (!access_token) throw new Error('the server returned no access token');
    return sdk.commands.authenticate({ access_token });
  }
  // (the display name when a logon name keeps all of it; one it would keep only part of, as "Bb" of "Bøb", is not
  // theirs: their user name then, which Discord keeps to letters a logon name has)
  const logonName = u => { const shown = String(u.global_name || '').trim(); return /^[\w.\- ]+$/.test(shown) ? shown : u.username || ''; };

  /** the person asks to be named: Discord's handshake, then their name theirs in the running session. The person
   *  ({ id, username, name }); rejects with why not, and may be asked again. One asking at a time */
  const authorize = () => asking || (asking = handshake().then(auth => {
    const u = (auth && auth.user) || {};
    who = { id: u.id || null, username: u.username || '', name: u.global_name || u.username || '' };
    const S = window.W95Shared; if (S) S.rename(logonName(u));
    return who;
  }).catch(e => {
    asking = null;
    console.warn('[discord] no identity from Discord, the person is Guest here:', (e && e.message) || e);
    throw e;
  }));

  // ---- the Authorize button: a stand-in over the screen's corner until Windows has a control of its own for it. Its
  // presses are its own (Windows under it gets none of them); gone once the person is named
  const button = () => {
    if (typeof document === 'undefined' || !document.body) return null;
    const b = document.createElement('button');
    b.id = 'discordAuthorize'; b.type = 'button'; b.textContent = 'Authorize';
    b.title = 'Use your Discord name in this session';
    b.style.cssText = 'position:fixed;top:6px;right:6px;z-index:2147483646;cursor:default;font:11px "MS Sans Serif",Tahoma,Arial,sans-serif;color:#000;'
      + 'background:#c0c0c0;padding:4px 14px;border:2px solid;border-color:#fff #000 #000 #fff;box-shadow:inset -1px -1px #808080,inset 1px 1px #dfdfdf;border-radius:0';
    for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'keydown', 'keyup', 'contextmenu']) b.addEventListener(t, e => e.stopPropagation());
    b.addEventListener('click', e => {
      e.stopPropagation(); if (b.disabled) return;
      b.disabled = true; b.textContent = 'Authorizing...';
      const back = () => { const c = document.getElementById('screen'); if (c) c.focus(); };   // (the keys are Windows' again)
      authorize().then(() => { b.remove(); back(); }, err => { b.disabled = false; b.textContent = 'Authorize'; b.title = `Discord did not name you: ${(err && err.message) || err}`; back(); });
    });
    document.body.appendChild(b);
    return b;
  };

  if (inside) {
    const S = window.W95Shared, room = session(q.get('instance_id'));
    // (Guest whatever name this browser kept: in Discord's frame a name is Discord's to give)
    if (S && room) { S.as('Guest', room); S.started.then(button); }
  }
  /** inside: this page is in Discord's frame. ready: Windows may start (at once: nothing waits for Discord).
   *  authorize(): as the Authorize button. sdk(): the SDK once made; user(): the person once named */
  window.W95Discord = { inside, session, ready: Promise.resolve(null), authorize, sdk: () => sdk, user: () => who };
})();
