# Turbo Karts

A 3D kart racing game that runs in the browser, on computers and phones.

- **Four tracks** (meadow, desert, snow, neon city), each with **Bronze, Silver and Gold** medal times. Earn a medal to unlock the next track.
- **Checkpoints that can't be skipped.** A lap only counts if you drive through every checkpoint arch in order. Cut across the map and the finish line does nothing; the game tells you which checkpoint you missed.
- **Drifting and boosts.** Hold drift through a corner until the sparks turn blue or orange, then let go for a boost. Boost pads on the road do the same.
- **Hills, bridges, jumps and gaps.** Roads climb and drop, one track crosses over itself on a bridge, ramps launch you into the air, and gaps in the road swallow anyone going under about 60 km/h (you are put back up the road with room for another run).
- **Obstacles.** Cones slow you down and go flying, tyre stacks stop you dead, and oil slicks send you sliding. Computer drivers steer round them.
- **Map builder.** Tap to place points and the road loops through them. Set the width, laps, scenery and number of checkpoints, raise points to make hills and bridges, drop boost pads, obstacles, ramps and gaps, then test drive. Medal times are worked out for you.
- **Accounts.** Sign in to keep your medals and best times, appear on leaderboards and share maps with everyone.
- **Versus.** Make a room, send your friends the code or link, and race up to 8 players online, on the built-in tracks or your own maps.

## Play it on your computer

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run build
npm start
```

Then open **http://localhost:8787**.

## Controls

| | Keyboard | Gamepad | Phone |
|---|---|---|---|
| Steer | Arrow keys or A / D | Left stick | ◀ ▶ buttons |
| Accelerate | Up or W | Right trigger / A | GO |
| Brake / reverse | Down or S | Left trigger / X | BRAKE |
| Drift | Space or Shift | Right bumper / B | DRIFT |
| Back to last checkpoint | R | Y | RESET |
| Pause | Esc | Start | II |
| Mute | M | | |

Engine sound (off, quiet or normal), sound effects and graphics quality are under **Settings** on the main menu and in the pause menu.

## Racing your friends

Versus needs everyone to open the same server, so the game has to be on the internet (or you all need to be on the same Wi-Fi, opening `http://<your-computer's-address>:8787`).

The quickest way is [Render](https://render.com), which has a free plan. The repository already has a `render.yaml` that sets everything up:

1. Sign up at render.com with your GitHub account and let it see this repository.
2. Click **New**, then **Blueprint**, and pick this repository.
3. Click **Apply**. After a few minutes Render shows a web address ending in `.onrender.com`. That is your game; send it to your friends.

On the free plan the game goes to sleep when nobody has played for 15 minutes (the next visit takes about a minute to wake it), and accounts and shared maps are wiped whenever it restarts. Medals saved on each player's own device are kept.

Any other host that runs Node works too (Railway, Fly.io, a VPS and so on):

- Build command: `npm install && npm run build`
- Start command: `npm start`
- The server listens on the `PORT` environment variable (8787 if not set).
- Accounts, best times and shared maps are saved in `server/data/db.json`. Set `DATA_FILE` to a path on a persistent disk so they survive restarts.
- Serve it over HTTPS (most hosts do this for you) so passwords are protected in transit.

### Without the server (Cloudflare and other static hosts)

The built game also runs as a plain website with no server behind it. `wrangler.jsonc` deploys it to Cloudflare that way.

- **Versus still works.** Players in a room share a Supabase Realtime channel and the player who made the room runs it; nothing is stored. The project address and its publishable key are in `src/net/config.js`.
- Racing, medals and the map builder work and save on each player's device.
- Sign-in, shared maps and leaderboards are switched off, because they need the server.

## For developers

```bash
npm run dev    # game with live reload on http://localhost:5173, server on :8787
npm test       # checkpoint rules, track maths, accounts, maps and versus rooms
```

| Folder | What is in it |
|---|---|
| `src/game/` | Track maths and checkpoint rules (`track.js`), kart handling and computer drivers (`physics.js`), the race loop (`game.js`), built-in tracks (`levels.js`) |
| `src/render/` | The 3D world and kart models, all generated in code (no art files) |
| `src/editor/` | The map builder |
| `src/net/` | Client code for accounts and versus |
| `server/` | The server: accounts (`store.js`), versus rooms (`rooms.js`) |

Things worth knowing:

- Medal times are set by driving a computer kart round the track at load time. Gold is that kart's time, Silver is 12% slower and Bronze 30% slower, so custom maps get fair targets automatically.
- Passwords are stored salted and hashed (scrypt), never as typed. Sign-in attempts are rate limited.
- In versus each player's own device runs their kart and reports their finish time, and the server passes it on. That is fine among friends but it is not cheat-proof; the same goes for leaderboard times.
- The data store is a single JSON file. It is fine for a group of friends; a public launch with many players should move to a real database.
