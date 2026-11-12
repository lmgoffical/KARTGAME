// Opens a Supabase Realtime broadcast channel for a versus room.

import { REALTIME } from './config.js';

let client = null;

/** Resolves to { send(type, data), close() }; `onMessage(type, data)` gets what others send. */
export async function openSupabaseChannel(code, onMessage) {
  // Loaded on demand so solo players never download it.
  const { createClient } = await import('@supabase/supabase-js');
  client ??= createClient(REALTIME.url, REALTIME.key, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { params: { eventsPerSecond: 20 } } });
  const channel = client.channel(REALTIME.prefix + code, { config: { broadcast: { self: false } } });
  channel.on('broadcast', { event: 'm' }, (msg) => {
    const p = msg?.payload;
    if (p && typeof p.e === 'string') onMessage(p.e, p.d);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 10000);
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(timer);
        resolve();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        clearTimeout(timer);
        reject(new Error(status));
      }
    });
  });
  return {
    send: (e, d) => channel.send({ type: 'broadcast', event: 'm', payload: { e, d } }),
    close: () => client.removeChannel(channel),
  };
}
