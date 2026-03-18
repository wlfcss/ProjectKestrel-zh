(function() {
  const GENERIC_SPECIES = {
    "": "",
    "unknown": "未知",
    "no bird": "无鸟",
    "error": "错误",
  };

  const GENERIC_FAMILY = {
    "": "",
    "unknown": "未知",
    "unknown family": "未知科",
    "n/a": "不适用",
  };

  let _taxonomy = {
    species: {},
    family_display: {},
    family_scientific: {},
  };
  let _loadPromise = null;

  function _normalize(value) {
    return String(value || "").trim().toLowerCase();
  }

  async function load() {
    if (_loadPromise) return _loadPromise;
    _loadPromise = fetch("taxonomy_zh_cn.json", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && typeof data === "object") {
          _taxonomy = {
            species: data.species || {},
            family_display: data.family_display || {},
            family_scientific: data.family_scientific || {},
          };
        }
        return _taxonomy;
      })
      .catch((err) => {
        console.warn("[taxonomy] Failed to load taxonomy_zh_cn.json:", err);
        return _taxonomy;
      });
    return _loadPromise;
  }

  function speciesDisplayName(name) {
    const value = String(name || "").trim();
    const generic = GENERIC_SPECIES[_normalize(value)];
    if (generic !== undefined) return generic;
    return _taxonomy.species[value] || value;
  }

  function familyDisplayName(name) {
    const value = String(name || "").trim();
    const generic = GENERIC_FAMILY[_normalize(value)];
    if (generic !== undefined) return generic;
    return _taxonomy.family_display[value] || _taxonomy.family_scientific[value] || value;
  }

  function speciesMatchesQuery(name, query) {
    const q = _normalize(query);
    if (!q) return true;
    const raw = _normalize(name);
    const display = _normalize(speciesDisplayName(name));
    return raw.includes(q) || display.includes(q);
  }

  window.KestrelTaxonomy = {
    load,
    speciesDisplayName,
    familyDisplayName,
    speciesMatchesQuery,
  };
})();
