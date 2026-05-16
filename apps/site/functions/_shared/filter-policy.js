export const FILTER_POLICY_OPEN_ALL = 1;
export const FILTER_POLICY_NETFREE_CHECK_ETROG_OPEN = 2;
export const FILTER_POLICY_NETFREE_ETROG_CHECK = 3;
export const FILTER_POLICY_SENSITIVE = 4;

export function normalizeFilterPolicy(value, fallback = FILTER_POLICY_NETFREE_ETROG_CHECK) {
  const n = Number(value);
  return [1, 2, 3, 4].includes(n) ? n : fallback;
}

export function netfreeDefaultStatusForPolicy(policy) {
  return normalizeFilterPolicy(policy) === FILTER_POLICY_OPEN_ALL ? 1 : 0;
}

export function showInPublicChannelsForPolicy(policy) {
  return normalizeFilterPolicy(policy) === FILTER_POLICY_OPEN_ALL ? 1 : 0;
}

export function etrogVisibleFromPolicyStatus(policy, status) {
  const p = normalizeFilterPolicy(policy);
  const s = Number(status);

  // 4 = unavailable. Do not show unavailable videos in Etrog either.
  if (s === 4) return 0;

  if (p === FILTER_POLICY_OPEN_ALL) return 1;
  if (p === FILTER_POLICY_NETFREE_CHECK_ETROG_OPEN) return 1;
  if (p === FILTER_POLICY_NETFREE_ETROG_CHECK) return s === 2 ? 0 : 1;
  if (p === FILTER_POLICY_SENSITIVE) return s === 1 ? 1 : 0;

  return 0;
}

export function etrogVisibleSqlCase(policySql = "COALESCE(c.filter_policy, 3)", statusSql = "v.netfree_status") {
  return `CASE
    WHEN ${statusSql} = 4 THEN 0
    WHEN ${policySql} = 1 THEN 1
    WHEN ${policySql} = 2 THEN 1
    WHEN ${policySql} = 3 AND ${statusSql} <> 2 THEN 1
    WHEN ${policySql} = 4 AND ${statusSql} = 1 THEN 1
    ELSE 0
  END`;
}

export function normalizePublicProvider(value) {
  const provider = String(value || "netfree").trim().toLowerCase();
  return provider === "etrog" ? "etrog" : "netfree";
}

export function publicProviderFromRequest(request, url = null) {
  const u = url || new URL(request.url);
  const fromQuery = u.searchParams.get("provider");
  if (fromQuery) return normalizePublicProvider(fromQuery);

  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)filter_provider=([^;]+)/);
  if (match) return normalizePublicProvider(decodeURIComponent(match[1] || ""));

  return "netfree";
}

export function publicVideoWhereSql(provider, alias = "v") {
  return normalizePublicProvider(provider) === "etrog"
    ? `${alias}.etrog_visible = 1`
    : `${alias}.netfree_status = 1`;
}

export function publicVideoIndexName(provider, netfreeIndex, etrogIndex) {
  return normalizePublicProvider(provider) === "etrog" ? etrogIndex : netfreeIndex;
}
