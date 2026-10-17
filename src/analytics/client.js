// What we know about a visitor from their request: rough location from Cloudflare and the
// device class from the user agent. No IP addresses are kept.

const BOT_RE = /bot|crawl|spider|slurp|preview|headless|lighthouse|monitor|curl|wget|python|node-fetch/i;

export function parseUserAgent(ua = '') {
  const device = /iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua)
    ? 'tablet'
    : /Mobi|iPhone|iPod|Android/i.test(ua)
      ? 'mobile'
      : 'desktop';

  let os = 'Other';
  if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/CrOS/i.test(ua)) os = 'ChromeOS';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser = 'Other';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser/i.test(ua)) browser = 'Samsung Internet';
  else if (/Firefox|FxiOS/i.test(ua)) browser = 'Firefox';
  else if (/Chrome|CriOS/i.test(ua)) browser = 'Chrome';
  else if (/Safari/i.test(ua)) browser = 'Safari';

  return { device, os, browser };
}

export function clientInfo(request) {
  const ua = request.headers.get('User-Agent') ?? '';
  const cf = request.cf ?? {};
  return {
    country: cf.country ?? null,
    region: cf.region ?? null,
    city: cf.city ?? null,
    ...parseUserAgent(ua),
    bot: BOT_RE.test(ua),
  };
}
