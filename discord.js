// Windows 95 as a Discord Activity: the page in Discord's frame (a voice channel's Activity) joins the session of that
// Activity's instance, as the person Discord says is there. The handshake is ~/kkfm-jukebox's (browser/discord-shell.js):
// the Embedded App SDK made with the application's id, ready(), authorize (scope identify) for a code, the code
// exchanged for an access token by this page's server (tools/discord_api.py: the client secret stays there), then
// authenticate, which answers with the person.
//
// Nothing of the session's logistics is replaced: shared.js runs the session as before, on the same server
// (tools/sessions.py). This only says which session and as whom before the page's store is chosen (host-web.js waits
// for `ready`): the session is the Activity's instance id, which everyone in the same Activity has (it is on the
// frame's URL, so it is known before the handshake ends), and the name is the person's Discord display name, or their
// user name when the display name has letters a logon name cannot keep. A handshake that fails or does not end leaves the
// person Guest in the instance's session, and Windows starts.
//
// The SDK is imported only in Discord's frame (its launch parameters on the URL: frame_id, instance_id, platform), from
// this origin (vendor/embedded-app-sdk.js: Discord's frame loads nothing from another origin), so a page anywhere else
// never asks for it.
(() => {
  const q = new URLSearchParams(location.search);
  const inside = q.has('frame_id');
  const TIMEOUT = 15000;   // (ready() never ends for a frame_id nobody answers: Windows starts without Discord then)
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

  const identify = async () => {
    const S = window.W95Shared, room = session(q.get('instance_id'));
    if (S && room) S.as(null, room);
    try {
      const auth = await Promise.race([handshake(), new Promise((_, no) => setTimeout(() => no(new Error('Discord did not answer')), TIMEOUT))]);
      const u = (auth && auth.user) || {};
      who = { id: u.id || null, username: u.username || '', name: u.global_name || u.username || '' };
      // (the display name when a logon name keeps all of it; one it would keep only part of, as "Bb" of "Bøb", is not
      // theirs: their user name then, which Discord keeps to letters a logon name has)
      const shown = String(u.global_name || '').trim();
      if (S) { S.as(u.username, room); if (/^[\w.\- ]+$/.test(shown)) S.as(shown, room); }
      return who;
    } catch (e) {
      console.warn('[discord] no identity from Discord, the person is Guest here:', (e && e.message) || e);
      return null;
    }
  };

  /** inside: this page is in Discord's frame; ready: the person Discord named ({ id, username, name }), or null (never
   *  rejects), after which W95Shared.logon is theirs; sdk(): the SDK once made */
  window.W95Discord = { inside, session, ready: inside ? identify() : Promise.resolve(null), sdk: () => sdk, user: () => who };
})();
