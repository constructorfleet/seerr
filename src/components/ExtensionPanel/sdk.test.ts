/**
 * The two things a panel gets handed for talking to its own server routes.
 *
 * Both exist because of mistakes that are invisible until a panel is running in a
 * browser: `createPanelApi` must inherit the app's CSRF configuration or every
 * non-GET route a panel calls is rejected, and `createPanelFetcher` must exist at
 * all because SWR's *global* fetcher resolves against core's `/api/v1`, so a panel
 * calling `useSWR('/items')` silently asked the wrong server. Neither failure shows
 * up in a type check, and each one cost the examples a hand-rolled `useEffect`
 * loader before it was found.
 *
 * These are unit tests rather than a Cypress spec because what matters is the
 * *request* — its URL and its headers — not what any page renders. `axios`'s
 * adapter is replaced so nothing leaves the process.
 */
import {
  createPanelApi,
  createPanelFetcher,
} from '@app/components/ExtensionPanel/sdk';
import type { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import axios from 'axios';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * Captures the config of every request an instance makes, answering each with
 * `body`, and returns the recorded configs.
 *
 * The adapter is swapped rather than the network stubbed, so the config observed
 * is the fully merged one axios would have sent — `baseURL` resolution included,
 * which is the part under test.
 */
function record(
  api: AxiosInstance,
  body: unknown = {}
): InternalAxiosRequestConfig[] {
  const configs: InternalAxiosRequestConfig[] = [];

  api.defaults.adapter = async (config) => {
    configs.push(config);

    return {
      data: body,
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    };
  };

  return configs;
}

describe('a panel’s API instance', () => {
  it('resolves a relative path against the extension’s own namespace', async () => {
    const api = createPanelApi('watch-history');
    const configs = record(api);

    await api.get('items');

    assert.equal(
      new URL(
        axios.getUri({ url: configs[0].url, baseURL: configs[0].baseURL }),
        'http://host'
      ).pathname,
      '/api/v1/ext/watch-history/items'
    );
  });

  it('keeps two extensions’ instances pointed at different namespaces', () => {
    // A panel is handed its own instance, so one extension's panel cannot reach
    // another's routes by relative path even by accident.
    assert.equal(createPanelApi('one').defaults.baseURL, '/api/v1/ext/one/');
    assert.equal(createPanelApi('two').defaults.baseURL, '/api/v1/ext/two/');
  });

  it('inherits the app’s CSRF cookie and header names', () => {
    // The server requires the `XSRF-TOKEN` cookie echoed as a header on non-GET
    // routes, so a panel that lost this configuration would have every mutation
    // refused. `axios.create` merges the defaults, so this holds for free — but
    // it is exactly the kind of free that a later `axios.create({...})` with an
    // explicit `xsrfCookieName: undefined` would quietly take away.
    const api = createPanelApi('demo');

    assert.equal(api.defaults.xsrfCookieName, axios.defaults.xsrfCookieName);
    assert.equal(api.defaults.xsrfHeaderName, axios.defaults.xsrfHeaderName);
  });

  it('is not the default instance, so a panel cannot reconfigure the host', () => {
    // A panel holds this object and can set defaults on it. That must not reach
    // core's axios, which every other request in the app uses.
    const api = createPanelApi('demo');

    assert.notEqual(api, axios);

    api.defaults.baseURL = '/somewhere/else';

    assert.equal(axios.defaults.baseURL, undefined);
  });
});

describe('a panel’s SWR fetcher', () => {
  it('returns the response body rather than the response', async () => {
    // SWR hands whatever this resolves to straight to the component as `data`,
    // so returning the axios response would make every panel write
    // `data.data.items`.
    const api = createPanelApi('demo');
    record(api, { items: ['a'] });

    const fetcher = createPanelFetcher(api);

    assert.deepEqual(await fetcher('/items'), { items: ['a'] });
  });

  it('sends the SWR key through the panel’s own instance', async () => {
    // The key doubles as the cache key, which is why it stays a relative path:
    // two extensions asking for `/items` do not collide, because each fetcher
    // resolves against its own `baseURL`.
    const api = createPanelApi('watch-history');
    const configs = record(api);

    await createPanelFetcher(api)('/items');

    assert.equal(configs.length, 1);
    assert.equal(configs[0].baseURL, '/api/v1/ext/watch-history/');
    assert.equal(configs[0].method, 'get');
  });

  it('rejects when the request fails, so SWR reports an error', async () => {
    // SWR distinguishes `data` from `error` by whether the fetcher rejected. A
    // fetcher that swallowed failures would leave a panel loading forever.
    const api = createPanelApi('demo');
    api.defaults.adapter = async () => {
      throw new Error('gone');
    };

    await assert.rejects(createPanelFetcher(api)('/items'), /gone/);
  });
});
