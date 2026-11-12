// Where versus races connect when the game is hosted as a plain website
// (for example on Cloudflare) with no game server behind it. Players in a
// room share one Supabase Realtime channel; nothing is stored. The key is a
// publishable (public) key, safe to ship in the page.
export const REALTIME = {
  url: 'https://muzcxirewzeqmmxxvowk.supabase.co',
  key: 'sb_publishable_CzJ54kTgvNKIDGSmZ8zFHg_lVe57CLY',
  prefix: 'turbokarts-',
};
