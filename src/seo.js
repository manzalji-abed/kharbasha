// The Arabic home page (/ar): the same page as /, served with Arabic as its language and
// Arabic titles for search results and link previews, so Arabic searches have a page to find.

const ORIGIN = 'https://kharbasha.abedmanzalji.com';
const AR = {
  title: 'خربشة · Kharbasha — لعبة ارسم وخمّن بالعربي والإنجليزي',
  description: 'لعبة رسم وتخمين مجانية أونلاين بالعربي والإنجليزي. افتح غرفة وادعُ أصدقاءك برابط، ثم ارسموا وخمّنوا ودردشوا معاً مباشرة — مع محادثة صوتية في الغرف الخاصة.',
  shareTitle: 'خربشة · Kharbasha — ارسم وخمّن مع أصدقائك',
  shareDescription: 'غرف مباشرة بالعربي والإنجليزي. ارسموا وخمّنوا واضحكوا معاً — مع محادثة صوتية في الغرف الخاصة.',
  imageAlt: 'خربشة — ارسم وخمّن واضحك مع أصدقائك، بالعربي والإنجليزي',
};

export async function arabicHome(request, env) {
  const page = await env.ASSETS.fetch(new Request(new URL('/', request.url)));
  const attr = (name, value) => ({ element: el => el.setAttribute(name, value) });
  return new HTMLRewriter()
    .on('html', {
      element: el => {
        el.setAttribute('lang', 'ar');
        el.setAttribute('dir', 'rtl');
        el.setAttribute('data-lang', 'ar'); // the app starts in Arabic
      },
    })
    .on('title', { element: el => el.setInnerContent(AR.title) })
    .on('meta[name="description"]', attr('content', AR.description))
    .on('link[rel="canonical"]', attr('href', `${ORIGIN}/ar`))
    .on('meta[property="og:url"]', attr('content', `${ORIGIN}/ar`))
    .on('meta[property="og:title"]', attr('content', AR.shareTitle))
    .on('meta[name="twitter:title"]', attr('content', AR.shareTitle))
    .on('meta[property="og:description"]', attr('content', AR.shareDescription))
    .on('meta[name="twitter:description"]', attr('content', AR.shareDescription))
    .on('meta[property="og:image:alt"]', attr('content', AR.imageAlt))
    .on('meta[property="og:locale"]', attr('content', 'ar_AR'))
    .on('meta[property="og:locale:alternate"]', attr('content', 'en_US'))
    .transform(page);
}
