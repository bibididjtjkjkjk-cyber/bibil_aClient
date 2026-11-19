'use strict';
/** Клиент Modrinth API v2 (https://docs.modrinth.com). Использует уникальный User-Agent и кэширует GET-запросы. */
const { getJson, postJson } = require('../util/http');
const { MODRINTH_API } = require('../config');

const enc = encodeURIComponent;
const CACHE_TTL = 60 * 1000;
const ID_RE = /^[\w-]{1,64}$/;

function checkId(id) {
  if (!ID_RE.test(String(id))) throw new Error('Некорректный идентификатор Modrinth');
  return id;
}

/** Строит facets для /search. */
function buildFacets({ gameVersion, loader, category, projectType = 'mod' }) {
  const facets = [[`project_type:${projectType}`]];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  if (projectType === 'mod' && loader) facets.push([`categories:${loader}`]);
  if (category) facets.push([`categories:${category}`]);
  return facets;
}

class ModrinthClient {
  constructor() {
    this.cache = new Map();
  }

  async _get(pathAndQuery) {
    const hit = this.cache.get(pathAndQuery);
    if (hit && Date.now() - hit.t < CACHE_TTL) return hit.data;
    const data = await getJson(MODRINTH_API + pathAndQuery);
    this.cache.set(pathAndQuery, { t: Date.now(), data });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
    return data;
  }

  async search({ query = '', gameVersion, loader, category, projectType = 'mod', index = 'relevance', offset = 0, limit = 20 }) {
    const type = projectType === 'resourcepack' ? 'resourcepack' : 'mod';
    const q = new URLSearchParams({
      query: String(query).slice(0, 100),
      facets: JSON.stringify(buildFacets({ gameVersion, loader: type === 'mod' ? loader : null, category, projectType: type })),
      index: ['relevance', 'downloads', 'follows', 'newest', 'updated'].includes(index) ? index : 'relevance',
      offset: String(Math.max(0, Math.floor(offset))),
      limit: String(Math.min(50, Math.max(1, Math.floor(limit)))),
    });
    const r = await this._get(`/search?${q}`);
    return {
      total: r.total_hits,
      hits: r.hits.map((h) => ({
        id: h.project_id,
        slug: h.slug,
        title: h.title,
        description: h.description,
        iconUrl: h.icon_url || null,
        author: h.author,
        downloads: h.downloads,
        follows: h.follows,
        projectType: h.project_type || type,
        categories: (h.display_categories || h.categories || []).filter((c) => !['fabric', 'forge', 'neoforge', 'quilt'].includes(c)),
        clientSide: h.client_side,
        serverSide: h.server_side,
      })),
    };
  }

  async categories(projectType = 'mod') {
    const all = await this._get('/tag/category');
    return all.filter((c) => c.project_type === projectType).map((c) => ({ name: c.name, header: c.header }));
  }

  async project(id) {
    const p = await this._get(`/project/${enc(checkId(id))}`);
    return {
      id: p.id,
      slug: p.slug,
      title: p.title,
      description: p.description,
      iconUrl: p.icon_url || null,
      downloads: p.downloads,
      follows: p.followers,
      license: p.license?.name || null,
      sourceUrl: p.source_url || null,
      issuesUrl: p.issues_url || null,
      projectType: p.project_type === 'resourcepack' ? 'resourcepack' : 'mod',
      pageUrl: `https://modrinth.com/${p.project_type === 'resourcepack' ? 'resourcepack' : 'mod'}/${p.slug}`,
    };
  }

  async projects(ids) {
    if (!ids.length) return [];
    ids.forEach(checkId);
    return this._get(`/projects?ids=${enc(JSON.stringify(ids))}`);
  }

  async projectVersions(id, { loaders, gameVersions } = {}) {
    const q = new URLSearchParams();
    if (loaders?.length) q.set('loaders', JSON.stringify(loaders));
    if (gameVersions?.length) q.set('game_versions', JSON.stringify(gameVersions));
    return this._get(`/project/${enc(checkId(id))}/version?${q}`);
  }

  getVersion(id) {
    return this._get(`/version/${enc(checkId(id))}`);
  }

  /** sha1 → версия (идентификация уже установленных файлов). */
  versionsByHashes(hashes) {
    return postJson(`${MODRINTH_API}/version_files`, { hashes, algorithm: 'sha1' });
  }

  /** sha1 → последняя совместимая версия. */
  latestByHashes(hashes, { loaders, gameVersions }) {
    return postJson(`${MODRINTH_API}/version_files/update`, {
      hashes,
      algorithm: 'sha1',
      loaders,
      game_versions: gameVersions,
    });
  }
}

/** Предпочитает release-версии, затем beta/alpha. Список приходит от новых к старым. */
function pickBestVersion(versions) {
  return versions.find((v) => v.version_type === 'release') || versions[0] || null;
}

module.exports = { ModrinthClient, buildFacets, pickBestVersion };
