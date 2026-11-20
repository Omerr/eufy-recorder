export interface YotoCatalog {
  players: { id: string; name: string; online: boolean }[];
  cards: { id: string; title: string; uri: string }[];
}

export async function yotoCatalog(token: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<YotoCatalog> {
  const get = async (route: string) => {
    const response = await fetcher('https://api.yotoplay.com' + route, {
      headers: { Authorization: `Bearer ${token}` }, signal, redirect: 'error',
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Yoto catalog request failed (HTTP ${response.status}).`); }
    return response.json();
  };
  const [devices, library] = await Promise.all([get('/device-v2/devices/mine'), get('/card/family/library')]);
  if (!Array.isArray(devices.devices) || !Array.isArray(library.cards)) throw new Error('Unexpected Yoto catalog format.');
  return {
    players: devices.devices.filter((player: Record<string, unknown>) => typeof player.deviceId === 'string').map((player: Record<string, unknown>) => ({
      id: String(player.deviceId), name: typeof player.name === 'string' ? player.name : 'Yoto player', online: player.online === true,
    })),
    cards: library.cards.filter((entry: Record<string, unknown>) => typeof entry.cardId === 'string').map((entry: { cardId: string; card?: { title?: string }; title?: string }) => ({
      id: entry.cardId, title: entry.card?.title || entry.title || 'Untitled card', uri: 'https://yoto.io/' + encodeURIComponent(entry.cardId),
    })),
  };
}
