const CACHE_VERSION = 'v14_lays_fix_2026';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/product') {
      return handleProductLookup(request, url, ctx);
    }

    return env.ASSETS.fetch(request);
  }
};

async function handleProductLookup(request, url, ctx) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: JSON_HEADERS });
  }

  const rawBarcode = (url.searchParams.get('barcode') || '').trim();
  const barcode = rawBarcode.replace(/\D/g, '');
  const forceFresh = url.searchParams.has('nocache') || url.searchParams.has('refresh');

  if (!barcode || barcode.length < 4 || barcode.length > 18) {
    return new Response(
      JSON.stringify({ found: false, error: 'Некорректный формат штрихкода' }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  let cache = null;
  let cacheKey = null;

  try {
    if (typeof caches !== 'undefined' && caches && caches.default) {
      cache = caches.default;
      const cacheUrl = new URL(`${url.origin}/api/product?ver=${CACHE_VERSION}&barcode=${encodeURIComponent(barcode)}`);
      cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
    }
  } catch (e) {
    console.warn('Cache init error:', e);
  }

  if (!forceFresh && cache && cacheKey) {
    try {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        const cachedJson = await cachedResponse.clone().json();
        if (cachedJson && cachedJson.found && !isGarbageTitle(cachedJson.name)) {
          const res = new Response(cachedResponse.body, cachedResponse);
          res.headers.set('X-Cache-Status', 'HIT');
          return res;
        }
      }
    } catch (e) {
      console.warn('Cache match error:', e);
    }
  }

  const { productData, hasUpstreamSuccess } = await searchAllDatabases(barcode);

  if (productData && productData.found && !isGarbageTitle(productData.name)) {
    const responsePayload = JSON.stringify(productData);
    const response = new Response(responsePayload, {
      status: 200,
      headers: {
        ...JSON_HEADERS,
        'Cache-Control': 'public, max-age=604800, s-maxage=604800',
        'X-Cache-Status': 'MISS'
      }
    });

    if (cache && cacheKey && ctx && typeof ctx.waitUntil === 'function') {
      try {
        ctx.waitUntil(
          cache.put(cacheKey, response.clone()).catch(err => {
            console.warn('Cache put background error:', err);
          })
        );
      } catch (e) {
        console.warn('Cache waitUntil error:', e);
      }
    }

    return response;
  }

  if (hasUpstreamSuccess) {
    return new Response(
      JSON.stringify({
        found: false,
        barcode: barcode,
        country: getCountryByPrefix(barcode)
      }),
      {
        status: 200,
        headers: {
          ...JSON_HEADERS,
          'Cache-Control': 'no-store, no-cache, must-revalidate'
        }
      }
    );
  }

  return new Response(
    JSON.stringify({
      found: false,
      error: 'Внешние базы данных временно недоступны. Повторите попытку.',
      barcode: barcode
    }),
    {
      status: 503,
      headers: {
        ...JSON_HEADERS,
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      }
    }
  );
}

async function searchAllDatabases(barcode) {
  const encCode = encodeURIComponent(barcode);
  const normBarcode = normalizeBarcode(barcode);
  const tasks = [];

  tasks.push(async () => {
    const url = `https://barcodes.olegon.ru/api/card/name/${encCode}`;
    const data = await fetchJsonWithTimeout(url, 2800, {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });

    if (data === null) return { ok: false, product: null };

    if (data && (data.status === 200 || data.names) && Array.isArray(data.names) && data.names.length > 0) {
      const rawName = data.names[0];
      const name = formatSupermarketTitle(rawName);

      if (name && !isGarbageTitle(name)) {
        return {
          ok: true,
          product: {
            found: true,
            barcode: barcode,
            name: name,
            brand: sanitizeBrand(extractBrand(name), name),
            category: deduceCategory(name, 'Продукты питания'),
            image: null,
            extra: 'База продуктов Olegon РФ',
            priority: 26
          }
        };
      }
    }
    return { ok: true, product: null };
  });

  tasks.push(async () => {
    const codeForCrpt = barcode.length === 12 ? `0${barcode}` : barcode;
    const url = `https://mobile.api.crpt.ru/mobile/check?code=${encodeURIComponent(codeForCrpt)}&codeType=ean13`;
    const data = await fetchJsonWithTimeout(url, 2500, {
      'Accept': 'application/json',
      'User-Agent': 'ChestnyZnak/5.0 (Android; ru)'
    });

    if (data === null) return { ok: false, product: null };

    if (data && (data.productName || data.name)) {
      const name = formatSupermarketTitle(data.productName || data.name);
      const brand = sanitizeBrand(data.producerName || data.brand, name);
      if (name && !isGarbageTitle(name)) {
        return {
          ok: true,
          product: {
            found: true,
            barcode: barcode,
            name: name,
            brand: brand,
            category: data.category ? cleanProductTitle(data.category) : deduceCategory(name),
            image: null,
            extra: [data.producerName ? `Производитель: ${data.producerName}` : null, 'Реестр «Честный Знак»'].filter(Boolean).join(' • '),
            priority: 25
          }
        };
      }
    }
    return { ok: true, product: null };
  });

  tasks.push(async () => {
    const url = `https://ru.openfoodfacts.org/api/v2/product/${encCode}.json?fields=code,product_name,product_name_ru,product_name_en,brands,brand_owner,categories_ru,categories,image_front_url,quantity,ingredients_text_ru`;
    const data = await fetchJsonWithTimeout(url, 3000, { 'User-Agent': 'TgProductScanner/3.5 (bot)' });
    if (data === null) return { ok: false, product: null };
    const parsed = parseOpenFactsResponse(data, barcode, 'Продукты питания', 24);
    return { ok: true, product: parsed };
  });

  tasks.push(async () => {
    const url = `https://ru.openfoodfacts.org/api/v0/product/${encCode}.json`;
    const data = await fetchJsonWithTimeout(url, 3000, { 'User-Agent': 'TgProductScanner/3.5 (bot)' });
    if (data === null) return { ok: false, product: null };
    const parsed = parseOpenFactsResponse(data, barcode, 'Продукты питания', 23);
    return { ok: true, product: parsed };
  });

  tasks.push(async () => {
    const url = `https://world.openfoodfacts.org/api/v2/product/${encCode}.json?fields=code,product_name,product_name_ru,product_name_en,brands,brand_owner,categories_ru,categories,image_front_url,quantity`;
    const data = await fetchJsonWithTimeout(url, 3000, { 'User-Agent': 'TgProductScanner/3.5 (bot)' });
    if (data === null) return { ok: false, product: null };
    const parsed = parseOpenFactsResponse(data, barcode, 'Продукты питания', 22);
    return { ok: true, product: parsed };
  });

  tasks.push(async () => {
    const url = `https://search.wb.ru/exactmatch/ru/common/v4/search?appType=1&curr=rub&dest=-1257786&query=${encCode}&resultset=catalog`;
    const data = await fetchJsonWithTimeout(url, 2500, {
      'Accept': '*/*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    });

    if (data === null) return { ok: false, product: null };

    if (data && data.data && Array.isArray(data.data.products) && data.data.products.length > 0) {
      let matchedItem = null;

      for (const item of data.data.products) {
        let isMatch = false;

        if (item.barcode && normalizeBarcode(item.barcode) === normBarcode) {
          isMatch = true;
        } else if (item.ean && normalizeBarcode(item.ean) === normBarcode) {
          isMatch = true;
        } else if (Array.isArray(item.sizes)) {
          for (const size of item.sizes) {
            if (Array.isArray(size.skus)) {
              for (const sku of size.skus) {
                if (normalizeBarcode(sku) === normBarcode) {
                  isMatch = true;
                  break;
                }
              }
            }
            if (isMatch) break;
          }
        }

        if (isMatch) {
          matchedItem = item;
          break;
        }
      }

      if (matchedItem) {
        const name = formatSupermarketTitle(matchedItem.name);
        const brand = sanitizeBrand(matchedItem.brand, name);

        if (name && !isGarbageTitle(name)) {
          let imageUrl = null;
          if (matchedItem.id) {
            const vol = Math.floor(matchedItem.id / 100000);
            const part = Math.floor(matchedItem.id / 1000);
            let basket = '01';
            if (vol >= 0 && vol <= 143) basket = '01';
            else if (vol <= 287) basket = '02';
            else if (vol <= 431) basket = '03';
            else if (vol <= 719) basket = '04';
            else if (vol <= 1007) basket = '05';
            else if (vol <= 1061) basket = '06';
            else if (vol <= 1115) basket = '07';
            else if (vol <= 1169) basket = '08';
            else if (vol <= 1313) basket = '09';
            else if (vol <= 1601) basket = '10';
            else if (vol <= 1655) basket = '11';
            else if (vol <= 1919) basket = '12';
            else if (vol <= 2045) basket = '13';
            else basket = '14';
            imageUrl = `https://basket-${basket}.wbbasket.ru/vol${vol}/part${part}/${matchedItem.id}/images/big/1.webp`;
          }

          return {
            ok: true,
            product: {
              found: true,
              barcode: barcode,
              name: name,
              brand: brand,
              category: deduceCategory(name, 'Товары общего назначения'),
              image: imageUrl,
              extra: matchedItem.rating ? `Рейтинг: ${matchedItem.rating} ★ • Wildberries` : 'Wildberries Каталог',
              priority: 25
            }
          };
        }
      }
    }
    return { ok: true, product: null };
  });

  tasks.push(async () => {
    const url = `https://world.openbeautyfacts.org/api/v2/product/${encCode}.json?fields=code,product_name,product_name_ru,brands,brand_owner,categories_ru,image_front_url,quantity`;
    const data = await fetchJsonWithTimeout(url, 3000, { 'User-Agent': 'TgProductScanner/3.5' });
    if (data === null) return { ok: false, product: null };
    const parsed = parseOpenFactsResponse(data, barcode, 'Косметика и уход', 21);
    return { ok: true, product: parsed };
  });

  tasks.push(async () => {
    const url = `https://world.openpetfoodfacts.org/api/v2/product/${encCode}.json?fields=code,product_name,product_name_ru,brands,categories_ru,image_front_url`;
    const data = await fetchJsonWithTimeout(url, 3000, { 'User-Agent': 'TgProductScanner/3.5' });
    if (data === null) return { ok: false, product: null };
    const parsed = parseOpenFactsResponse(data, barcode, 'Зоотовары', 20);
    return { ok: true, product: parsed };
  });

  tasks.push(async () => {
    const url = `https://api.upcitemdb.com/prod/trial/lookup?upc=${encCode}`;
    const data = await fetchJsonWithTimeout(url, 3000, {
      'Accept': 'application/json',
      'User-Agent': 'TgProductScanner/3.5'
    });

    if (data === null) return { ok: false, product: null };

    if (data && Array.isArray(data.items) && data.items.length > 0) {
      const item = data.items.find(it => {
        const itEan = normalizeBarcode(it.ean || '');
        const itUpc = normalizeBarcode(it.upc || '');
        return itEan === normBarcode || itUpc === normBarcode;
      }) || data.items[0];

      if (!item) return { ok: true, product: null };

      const itemEan = normalizeBarcode(item.ean || '');
      const itemUpc = normalizeBarcode(item.upc || '');
      if (itemEan && itemEan !== normBarcode && itemUpc && itemUpc !== normBarcode) {
        return { ok: true, product: null };
      }

      const name = formatSupermarketTitle(item.title || '');
      const brand = sanitizeBrand(item.brand, name);
      const image = (item.images && item.images.length > 0) ? item.images[0] : null;

      if (name && !isGarbageTitle(name)) {
        return {
          ok: true,
          product: {
            found: true,
            barcode: item.ean || item.upc || barcode,
            name: name,
            brand: brand,
            category: item.category ? cleanProductTitle(item.category) : deduceCategory(name),
            image: image,
            extra: 'База UPCitemdb Global',
            priority: 18
          }
        };
      }
    }
    return { ok: true, product: null };
  });

  tasks.push(async () => {
    const url = `https://barcode-list.ru/barcode/RU/%D0%9F%D0%BE%D0%B8%D1%81%D0%BA.htm?barcode=${encodeURIComponent(barcode)}`;
    const html = await fetchTextWithTimeout(url, 3500);
    if (!html) return { ok: false, product: null };

    let title = '';

    const tableRowMatches = [...html.matchAll(/<tr[^>]*>\s*<td[^>]*>\s*\d+\s*<\/td>\s*<td[^>]*>\s*\d+\s*<\/td>\s*<td[^>]*>([^<]+)<\/td>/gi)];
    for (const row of tableRowMatches) {
      if (row && row[1]) {
        const candidate = formatSupermarketTitle(row[1]);
        if (!isGarbageTitle(candidate)) {
          title = candidate;
          break;
        }
      }
    }

    if (!title) {
      const listMatch = html.match(/встречается в следующих товарах:\s*([^<\n\r]+)/i);
      if (listMatch && listMatch[1]) {
        const items = listMatch[1].split(';').map(s => formatSupermarketTitle(s)).filter(s => !isGarbageTitle(s));
        if (items.length > 0) title = items[0];
      }
    }

    if (title && !isGarbageTitle(title)) {
      const brand = sanitizeBrand(extractBrand(title), title);
      const category = deduceCategory(title);

      return {
        ok: true,
        product: {
          found: true,
          barcode: barcode,
          name: title,
          brand: brand,
          category: category,
          image: null,
          extra: 'База Barcode-List РФ',
          priority: 15
        }
      };
    }

    return { ok: true, product: null };
  });

  tasks.push(async () => {
    const query = encodeURIComponent(`"${barcode}" товар купить`);
    const url = `https://html.duckduckgo.com/html/?q=${query}`;
    const html = await fetchTextWithTimeout(url, 3500);
    if (!html) return { ok: false, product: null };

    const matches = [...html.matchAll(/class="result__a"[^>]*>([\s\S]*?)<\/a>/gi)];
    for (const m of matches) {
      if (m && m[1]) {
        const candidate = formatSupermarketTitle(m[1]);

        if (candidate.length > 5 && !isGarbageTitle(candidate)) {
          const brand = sanitizeBrand(extractBrand(candidate), candidate);
          return {
            ok: true,
            product: {
              found: true,
              barcode: barcode,
              name: candidate,
              brand: brand,
              category: deduceCategory(candidate),
              image: null,
              extra: 'Поиск в сети',
              priority: 2
            }
          };
        }
      }
    }

    return { ok: true, product: null };
  });

  const results = await Promise.allSettled(tasks.map(t => t()));
  let hasUpstreamSuccess = false;
  const candidates = [];

  for (const res of results) {
    if (res.status === 'fulfilled' && res.value) {
      if (res.value.ok) {
        hasUpstreamSuccess = true;
      }
      if (res.value.product && res.value.product.found) {
        if (!isGarbageTitle(res.value.product.name)) {
          candidates.push(res.value.product);
        }
      }
    }
  }

  if (candidates.length === 0) {
    return { productData: null, hasUpstreamSuccess };
  }

  candidates.sort((a, b) => {
    let scoreA = (a.priority || 10) + (a.image ? 6 : 0) + (a.brand && a.brand !== 'Бренд не указан' ? 3 : 0);
    let scoreB = (b.priority || 10) + (b.image ? 6 : 0) + (b.brand && b.brand !== 'Бренд не указан' ? 3 : 0);
    return scoreB - scoreA;
  });

  return { productData: candidates[0], hasUpstreamSuccess: true };
}

function normalizeBarcode(str) {
  if (!str) return '';
  return String(str).replace(/\D/g, '').replace(/^0+/, '');
}

async function fetchJsonWithTimeout(url, timeoutMs = 3000, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        ...headers
      }
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

async function fetchTextWithTimeout(url, timeoutMs = 3500, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8',
        ...headers
      }
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

function parseOpenFactsResponse(data, originalBarcode, fallbackCategory, priority = 20) {
  if (!data || !data.product) return null;
  const p = data.product;

  const returnedCode = String(p.code || '').trim();
  if (returnedCode) {
    const normReturned = normalizeBarcode(returnedCode);
    const normOriginal = normalizeBarcode(originalBarcode);
    if (normReturned && normOriginal && normReturned !== normOriginal) {
      return null;
    }
  }

  const name = formatSupermarketTitle(p.product_name_ru || p.product_name || p.product_name_en || '');
  const brand = sanitizeBrand(p.brands || p.brand_owner || '', name);

  if (!name && brand === 'Бренд не указан') return null;
  if (isGarbageTitle(name)) return null;

  const rawCat = p.categories_ru || p.categories || '';
  const category = rawCat
    .split(',')
    .map(c => c.trim().replace(/^[a-z]{2}:/, ''))
    .filter(Boolean)
    .slice(0, 2)
    .join(', ') || deduceCategory(name, fallbackCategory);

  const image = p.image_front_url || null;
  const extraParts = [];
  if (p.quantity) extraParts.push(p.quantity.trim());
  const country = getCountryByPrefix(originalBarcode);
  if (country) extraParts.push(country);

  return {
    found: true,
    barcode: p.code || originalBarcode,
    name: name || 'Наименование не указано',
    brand: brand,
    category: category,
    image: image,
    extra: extraParts.join(' • ') || null,
    priority: priority
  };
}

function formatSupermarketTitle(raw) {
  if (!raw) return '';
  let str = cleanProductTitle(raw);
  if (!str) return '';

  if (str === str.toUpperCase() && str.length > 5 && /[А-ЯA-Z]/.test(str)) {
    const words = str.toLowerCase().split(/\s+/);
    str = words.map(w => {
      if (['пэт', 'гост', 'ту', 'бжу', 'ру', 'рф', 'ооо', 'зао', 'оао', 'пао', 'спб', 'ккал', 'usb', 'led', 'eco', 'bio'].includes(w)) {
        return w.toUpperCase();
      }
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }

  return str;
}

function isGarbageTitle(title) {
  if (!title || typeof title !== 'string') return true;
  const t = title.toLowerCase().trim();

  if (t.length < 3) return true;
  if (/^\d+$/.test(t.replace(/\s+/g, ''))) return true;

  const stopKeywords = [
    'проверить', 'проверка', 'проверьте',
    'штрих-код', 'штрихкод', 'штрих код', 'штрих-кода', 'штрихкода', 'штрих коды', 'штрих-коды',
    'подлинност', 'подлинный', 'страна-производитель', 'страна производитель', 'страна изготовитель',
    'база данных', 'генератор', 'справочник', 'реестр', 'поиск по', 'поиск штрих', 'поиск товара',
    'расшифровк', 'онлайн сканер', 'онлайн-сканер', 'каталог штрих', 'каталог товаров',
    'spravportal', 'sprav-portal', 'goods-scanner', 'service-online', 'infotables', 'barcodes4',
    'barcode', 'lookup', 'generator', 'ean-13', 'ean13', 'ean 13', 'ean-8', 'upc-a', 'upc',
    'результаты поиска', 'найдено по запросу', 'не найден', 'товар не найден', 'ничего не найдено',
    'главная страница', 'страница не найдена', '404 not found', 'ошибка 404', 'вход в личный',
    'онлайн сервис', 'бесплатный сервис', 'валидатор', 'декодер', 'контрольная цифра',
    'информация о товаре по', 'узнать по штрихкоду', 'определить по штрихкоду'
  ];

  for (const kw of stopKeywords) {
    if (t.includes(kw)) return true;
  }

  if (/^[a-z0-9\-\.]+\.(ru|com|net|org|io|me|su|by|ua|kz)$/i.test(t)) return true;

  return false;
}

function cleanProductTitle(str) {
  if (!str) return '';
  let cleaned = cleanHtml(str)
    .replace(/\s*[\-\|\–\—]\s*(Купить|Ozon|Wildberries|Вайлдберриз|WB|Amazon|eBay|DNS|СберМегамаркет|Мегамаркет|Яндекс\s*Маркет|Лента|Ашан|Магнит|Пятерочка|SpravPortal|Barcode.*|Штрихкод.*|Интернет-магазин.*)$/i, '')
    .replace(/\s*(купить по выгодной цене|в наличии|с доставкой|по низкой цене).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  cleaned = cleaned.replace(/^["'«“](.*)["'»”]$/, '$1').trim();
  return cleaned;
}

function sanitizeBrand(brand, productName = '') {
  let b = (brand && typeof brand === 'string') ? cleanHtml(brand).trim() : '';

  if (!b || b.length < 2 || b.length > 35 || isGarbageTitle(b)) {
    b = extractBrand(productName);
  }

  const badBrands = ['проверить', 'поиск', 'штрихкод', 'barcode', 'россия', 'unknown', 'не указан', 'купить', 'ozon', 'wildberries', 'яндекс'];
  if (badBrands.includes(b.toLowerCase())) {
    b = extractBrand(productName);
  }

  if (/lay'?s|ле[йи]с/i.test(b)) {
    return "Lay's";
  }

  return b || 'Бренд не указан';
}

function extractBrand(title) {
  if (!title) return 'Бренд не указан';

  const tLower = title.toLowerCase();

  if (/lay'?s|ле[йи]с/i.test(tLower)) {
    return "Lay's";
  }

  const quoteMatch = title.match(/["«“]([^"»”]+)["»”]/);
  if (quoteMatch && quoteMatch[1]) {
    const candidate = quoteMatch[1].trim();
    if (candidate.length >= 2 && candidate.length <= 30 && !isGarbageTitle(candidate)) {
      const lower = candidate.toLowerCase();
      if (!['купить', 'товар', 'акция', 'новинка', 'цена', 'отзывы', 'проверить', 'оригинал', 'гост'].includes(lower)) {
        if (/lay'?s|ле[йи]с/i.test(lower)) return "Lay's";
        return candidate;
      }
    }
  }

  const knownBrands = [
    'Простоквашино', 'Домик в деревне', 'Савушкин', 'Агуша', 'ФрутоНяня', 'Тема', 'Danone', 'Epica',
    'Брест-Литовск', 'Вкуснотеево', 'Коровка из Кореновки', 'Слобода', 'Махеевъ', 'Ряба', 'Heinz',
    'Мираторг', 'Вязанка', 'Папа Может', 'Останкино', 'Дым Дымыч', 'Черкизово', 'Дмитрогорский',
    'Lay\'s', 'Lays', 'Лейс', 'Леис', 'Pringles', 'Русская Картошка', 'Cheetos', 'Хрустим', 'Балтика', 'Черноголовка',
    'Добрый', 'Моя Семья', 'Rich', 'J7', 'Любимый', 'Coca-Cola', 'Pepsi', 'Fanta', 'Sprite', 'Borjomi',
    'Святой Источник', 'БонАква', 'Аква Минерале', 'Raffaello', 'Ferrero', 'Kinder', 'Alpen Gold',
    'Milka', 'Аленка', 'Бабаевский', 'Красный Октябрь', 'Рот Фронт', 'Nestle', 'Nesquik', 'Snickers',
    'Mars', 'Twix', 'Bounty', 'KitKat', 'MacCoffee', 'Jacobs', 'Nescafe', 'Greenfield', 'Tess', 'Richard',
    'Curtis', 'Майский', 'Lipton', 'Barilla', 'Makfa', 'Макфа', 'Шебекинские', 'Увелка', 'Мистраль',
    'Красная Цена', 'Моя Цена', 'Каждый День', 'Маркет Перекресток', 'ВкусВилл'
  ];

  for (const b of knownBrands) {
    if (tLower.includes(b.toLowerCase())) {
      if (['лейс', 'леис', 'lays', "lay's"].includes(b.toLowerCase())) {
        return "Lay's";
      }
      return b;
    }
  }

  const words = title.split(/\s+/);
  for (const word of words) {
    const cleanWord = word.replace(/[^a-zA-Zа-яА-ЯёЁ0-9\-_]/g, '');
    if (/^[A-ZА-ЯЁ][a-zA-Zа-яА-ЯёЁ0-9\-_]{2,}$/.test(cleanWord)) {
      const lower = cleanWord.toLowerCase();
      if (!['the', 'and', 'for', 'with', 'from', 'best', 'shop', 'store', 'sale', 'new', 'gost', 'чипсы', 'товар', 'напиток', 'сухарики', 'хлеб', 'масло', 'сыр', 'вода', 'мясо', 'колбаса', 'молоко'].includes(lower)) {
        if (/lay'?s|ле[йи]с/i.test(lower)) return "Lay's";
        return cleanWord;
      }
    }
  }

  return 'Бренд не указан';
}

function deduceCategory(name, defaultCat = 'Товары общего назначения') {
  if (!name) return defaultCat;
  const n = name.toLowerCase();

  if (/молок|кефир|творог|сметан|масло слив|сыр|йогурт|ряженк|сливки|десерт творого|сырок|снежок|простокваш/i.test(n)) return 'Молочная продукция';
  if (/колбас|сосиск|сардельк|ветчин|мясо|говядин|свинин|куриц|индейк|фарш|бекон|паштет|карбонад|грудинк/i.test(n)) return 'Мясная продукция';
  if (/чипс|сухарик|снек|соломк|попкорн|крендел|ле[йи]с|lays|начос|арахис|фисташк|семечк/i.test(n)) return 'Снеки и чипсы';
  if (/шоколад|конфет|мармелад|батончик|торт|пирожн|зефир|халва|печень|вафл|пряник|круассан|варень|джем/i.test(n)) return 'Кондитерские изделия';
  if (/хлеб|батон|булочк|лаваш|лепешк|багет|булка|сухари/i.test(n)) return 'Хлеб и выпечка';
  if (/вода|сок|нектар|напиток|лимонад|кола|чай|кофе|квас|морс|энергетик|pepsi|coca|компот/i.test(n)) return 'Напитки и соки';
  if (/пиво|вино|водка|коньяк|виски|сидр|шампанск|ром|джин|текила|ликер/i.test(n)) return 'Алкогольная продукция';
  if (/макарон|спагетти|крупа|рис|гречк|овсянк|хлопь|мука|сахар|соль|масло растит|масло подсолн|масло оливк|соус|майонез|кетчуп|томатн|консерв|горошек|кукуруз|фасоль/i.test(n)) return 'Бакалея и консервация';
  if (/пюре детск|каша детск|смесь детск|сок детск|памперс|подгузник|агуша|фрутоняня/i.test(n)) return 'Детское питание и уход';
  if (/лосьон|шампунь|гель для душ|мыло|паста зубн|дезодорант|крем|маска|бальзам|parfum|perfume/i.test(n)) return 'Косметика и гигиена';
  if (/порошок|кондиционер|чистящ|моющее|салфетк|бумага туалет|белизна|капсулы для стирк|fairy|domestos/i.test(n)) return 'Бытовая химия';
  if (/корм|для кошек|для собак|для щенков|whiskas|kitekat|purina|felix|pedigree|chappi/i.test(n)) return 'Зоотовары';
  if (/телефон|смартфон|кабель|провод|наушник|зарядк|аккумулятор|usb/i.test(n)) return 'Электроника';

  return defaultCat;
}

function cleanHtml(str) {
  if (!str) return '';
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function getCountryByPrefix(code) {
  if (!code || code.length < 3) return null;
  const p3 = parseInt(code.substring(0, 3), 10);

  if (p3 >= 460 && p3 <= 469) return 'Россия';
  if (p3 === 481) return 'Беларусь';
  if (p3 === 482) return 'Украина';
  if (p3 === 487) return 'Казахстан';
  if (p3 === 478) return 'Узбекистан';
  if (p3 === 485) return 'Армения';
  if (p3 === 486) return 'Грузия';
  if (p3 === 484) return 'Молдова';
  if (p3 === 476) return 'Азербайджан';
  if (p3 === 470) return 'Кыргызстан';
  if (p3 === 488) return 'Таджикистан';
  if (p3 === 483) return 'Туркменистан';
  if (p3 >= 400 && p3 <= 440) return 'Германия';
  if (p3 >= 300 && p3 <= 379) return 'Франция';
  if (p3 >= 800 && p3 <= 839) return 'Италия';
  if (p3 >= 840 && p3 <= 849) return 'Испания';
  if (p3 >= 500 && p3 <= 509) return 'Великобритания';
  if (p3 >= 690 && p3 <= 699) return 'Китай';
  if ((p3 >= 450 && p3 <= 459) || (p3 >= 490 && p3 <= 499)) return 'Япония';
  if (p3 === 880) return 'Южная Корея';
  if (p3 === 869) return 'Турция';
  if (p3 <= 139) return 'США / Канада';
  return null;
}