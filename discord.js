// Windows 95 as a Discord Activity: the page in Discord's frame (a voice channel's Activity) joins the session of that
// Activity's instance, as the person Discord says is there. The handshake is ~/kkfm-jukebox's (browser/discord-shell.js):
// the Embedded App SDK made with the application's id, ready(), authorize (scope identify) for a code, the code
// exchanged for an access token by this page's server (tools/discord_api.py: the client secret stays there), then
// authenticate, which answers with the person.
//
// Nothing of the session's logistics is replaced: shared.js runs the session as before, on the same server
// (tools/sessions.py). This only says which session and as whom. The session is the Activity's instance id, which
// everyone in the same Activity has: it is on the frame's URL, so it is known at once, and Windows never waits for
// Discord to start. The name is the person's Discord display name, or their user name when the display name has
// letters a logon name cannot keep.
//
// Discord asks the person to authorize the application the first time (authorize shows its form), and nothing here
// can tell beforehand whether it will. So a person this browser has not seen authorize starts as Guest, is asked once
// Windows has started, and takes their name in the running session when Discord gives it (shared.js rename: the others
// see the name change). One this browser has seen authorize is asked nothing, so the handshake runs before the page's
// store is chosen (host-web.js waits for `ready`, a few seconds at most) and Windows starts under their name. A
// handshake that fails, or a form left unanswered, leaves the person Guest in the instance's session.
//
// The SDK is imported only in Discord's frame (its launch parameters on the URL: frame_id, instance_id, platform), from
// this origin (vendor/embedded-app-sdk.js: Discord's frame loads nothing from another origin), so a page anywhere else
// never asks for it.
(() => {
  const q = new URLSearchParams(location.search);
  const inside = q.has('frame_id');
  const BEFORE = 4000;                        // (how long Windows' start waits for the name of a person asked nothing)
  const AUTHORIZED = 'w95.discord.authorized';   // (this browser has seen the person authorize: localStorage)
  const kept = () => { try { return localStorage.getItem(AUTHORIZED) === '1'; } catch (_) { return false; } };
  const keep = on => { try { on ? localStorage.setItem(AUTHORIZED, '1') : localStorage.removeItem(AUTHORIZED); } catch (_) { /* no storage */ } };
  let sdk = null, who = null;

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

  async function handshake() {
    const id = await clientId();
    if (!id) throw new Error('no Discord application id (W95_DISCORD_CLIENT_ID on the server)');
    const { DiscordSDK } = await import('./vendor/embedded-app-sdk.js');
    // (the SDK would send every console line to Discord's client: this page's machines say a lot)
    sdk = new DiscordSDK(id, { disableConsoleLogOverride: true });
    await sdk.ready();
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

  const identify = () => {
    const S = window.W95Shared, room = session(q.get('instance_id'));
    if (S && room) S.as(null, room);
    const seen = kept();
    let started = false;
    // the person, asked now if this browser has seen them authorize, else once Windows has started; never rejects
    const asked = (seen || !S ? Promise.resolve() : S.started).then(handshake).then(auth => {
      const u = (auth && auth.user) || {};
      who = { id: u.id || null, username: u.username || '', name: u.global_name || u.username || '' };
      keep(true);
      // (their name: the logon's if Windows has not started, else this person's in the running session)
      if (S) { const n = logonName(u); if (started) S.rename(n); else S.as(n, room); }
      return who;
    }, e => {
      keep(false);
      console.warn('[discord] no identity from Discord, the person is Guest here:', (e && e.message) || e);
      return null;
    });
    const soon = seen ? Promise.race([asked, new Promise(ok => setTimeout(() => ok(null), BEFORE))]) : Promise.resolve(null);
    return { ready: soon.then(w => { started = true; return w; }), identity: asked };
  };

  /** inside: this page is in Discord's frame. ready: Windows may start (never rejects, never waits for a person to
   *  answer Discord): the person ({ id, username, name }) if Discord named them in time, else null. identity: the person
   *  whenever Discord names them (null if it does not), by when W95Shared's logon or session name is theirs. sdk(): the
   *  SDK once made */
  const I = inside ? identify() : { ready: Promise.resolve(null), identity: Promise.resolve(null) };
  window.W95Discord = { inside, session, ready: I.ready, identity: I.identity, sdk: () => sdk, user: () => who };
})();
