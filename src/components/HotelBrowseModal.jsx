import { useState, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import GoogleMapView from "./GoogleMapView.jsx";
import { forwardGeocode, generateHotelInsights } from "../api.js";

const FILTER_TAGS = ["역세권", "가성비", "시설좋음", "비즈니스", "럭셔리", "조용함", "관광중심"];

/**
 * HotelBrowseModal — full-screen overlay for real hotel discovery.
 *
 * Two modes:
 *   1) 🤖 AI 추천 호텔 — Google Places API (New) `lodging` search → real hotels
 *      with photos, ratings, price level; user picks from list/map.
 *   2) ✏️ 직접 입력 — User already booked → manual form (name, address,
 *      check-in/out, notes). Geocoded on save so the timeline anchor works.
 *
 * onSelect receives a lodging-shaped object:
 *   { id, name, summary, area, latlng, rating?, priceLevel?, photoUrl?,
 *     checkIn?, checkOut?, notes?, isCustom? }
 */

async function searchHotels(query) {
  if (!window.google?.maps?.places?.Place) {
    console.warn("[HotelBrowseModal] google.maps.places.Place not available");
    return [];
  }
  try {
    const { places } = await window.google.maps.places.Place.searchByText({
      textQuery: `${query} 호텔`,
      fields: [
        "displayName",
        "location",
        "photos",
        "rating",
        "priceLevel",
        "formattedAddress",
        "id",
        "userRatingCount",
      ],
      maxResultCount: 20,
      includedType: "lodging",
      language: "ko",
    });
    return (places ?? [])
      .map((p) => ({
        id: p.id,
        name: p.displayName ?? "(이름 없음)",
        address: p.formattedAddress ?? "",
        latlng: p.location ? [p.location.lat(), p.location.lng()] : null,
        rating: p.rating ?? null,
        ratingCount: p.userRatingCount ?? null,
        priceLevel: p.priceLevel ?? null,
        photoUrl: p.photos?.[0]?.getURI?.({ maxWidth: 400 }) ?? null,
      }))
      .filter((h) => h.latlng);
  } catch (err) {
    console.error("[HotelBrowseModal] searchHotels failed:", err);
    return [];
  }
}

/** Build an external booking search URL. Booking.com / Agoda don't offer
 *  free inventory APIs, so we generate a search-results deeplink using the
 *  hotel name + address. User finishes the booking on the external site. */
export function bookingSearchUrl(hotel) {
  const q = `${hotel?.name ?? ""} ${hotel?.address ?? hotel?.area ?? ""}`.trim();
  return `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(q)}`;
}
export function agodaSearchUrl(hotel) {
  const q = `${hotel?.name ?? ""} ${hotel?.address ?? hotel?.area ?? ""}`.trim();
  return `https://www.agoda.com/search?q=${encodeURIComponent(q)}`;
}
export function googleMapsUrl(hotel) {
  const q = `${hotel?.name ?? ""} ${hotel?.address ?? hotel?.area ?? ""}`.trim();
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

function priceLevelLabel(level) {
  // Google returns PRICE_LEVEL_INEXPENSIVE | MODERATE | EXPENSIVE | VERY_EXPENSIVE
  const map = {
    PRICE_LEVEL_INEXPENSIVE: "¥",
    PRICE_LEVEL_MODERATE: "¥¥",
    PRICE_LEVEL_EXPENSIVE: "¥¥¥",
    PRICE_LEVEL_VERY_EXPENSIVE: "¥¥¥¥",
  };
  return map[level] ?? null;
}

const FAVORITES_KEY = "ai-travel-guide:hotel-favorites";

function loadFavoritesFromStorage() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export default function HotelBrowseModal({ isOpen, onClose, country, region, onSelect, onLog }) {
  const [tab, setTab] = useState("browse");
  const [hotels, setHotels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedHotel, setSelectedHotel] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [customInput, setCustomInput] = useState({
    name: "",
    address: "",
    checkIn: "",
    checkOut: "",
    notes: "",
  });
  const [customSaving, setCustomSaving] = useState(false);
  const [favorites, setFavorites] = useState(() => loadFavoritesFromStorage());
  const [showFavOnly, setShowFavOnly] = useState(false);
  // LLM-generated insights keyed by hotel id. Loaded asynchronously after the
  // Places search returns so the card list can render immediately.
  const [insightsById, setInsightsById] = useState({});
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [activeFilter, setActiveFilter] = useState(null);

  const toggleFavorite = useCallback((id) => {
    setFavorites((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  // Merge LLM insights into each hotel so downstream code can read h.insights.
  const decoratedHotels = useMemo(
    () => hotels.map((h) => ({ ...h, insights: insightsById[h.id] ?? null })),
    [hotels, insightsById]
  );

  // Filter + sort: favorites bubble to the top; 즐겨찾기 toggle restricts to
  // saved; filter chip restricts by tag (requires insights loaded).
  const visibleHotels = useMemo(() => {
    let list = decoratedHotels;
    if (showFavOnly) list = list.filter((h) => favorites.includes(h.id));
    if (activeFilter) list = list.filter((h) => h.insights?.tags?.includes(activeFilter));
    if (!showFavOnly && !activeFilter) {
      list = [...list].sort((a, b) => {
        const af = favorites.includes(a.id) ? 1 : 0;
        const bf = favorites.includes(b.id) ? 1 : 0;
        return bf - af;
      });
    }
    return list;
  }, [decoratedHotels, showFavOnly, activeFilter, favorites]);

  // ESC to close
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  // Kick off LLM-based insights for a freshly-loaded hotel list. Runs async so
  // the card list can render immediately; insights fill in when ready.
  const loadInsightsFor = useCallback(async (list) => {
    if (!list || list.length === 0) return;
    setInsightsLoading(true);
    try {
      const result = await generateHotelInsights(list, { country, region }, onLog);
      if (!result) return;
      const map = {};
      for (const item of result) {
        if (item?.id) map[item.id] = item;
      }
      setInsightsById((prev) => ({ ...prev, ...map }));
    } finally {
      setInsightsLoading(false);
    }
  }, [country, region, onLog]);

  // Initial search when modal opens / destination changes
  useEffect(() => {
    if (!isOpen || tab !== "browse") return;
    const query = `${region || ""} ${country || ""}`.trim();
    if (!query) return;
    setLoading(true);
    setActiveFilter(null);
    searchHotels(query).then((results) => {
      setHotels(results);
      setInsightsById({});
      setLoading(false);
      setSelectedHotel(results[0] ?? null);
      loadInsightsFor(results);
    });
  }, [isOpen, tab, country, region, loadInsightsFor]);

  const handleSearch = useCallback(async () => {
    const query = searchQuery.trim() || `${region} ${country}`;
    setLoading(true);
    setActiveFilter(null);
    const results = await searchHotels(query);
    setHotels(results);
    setInsightsById({});
    setLoading(false);
    setSelectedHotel(results[0] ?? null);
    loadInsightsFor(results);
  }, [searchQuery, country, region, loadInsightsFor]);

  const handleBrowseSelect = useCallback(() => {
    if (!selectedHotel) return;
    onSelect({
      id: `gp-${selectedHotel.id}`,
      name: selectedHotel.name,
      summary: selectedHotel.address,
      area: region,
      latlng: selectedHotel.latlng,
      rating: selectedHotel.rating,
      priceLevel: selectedHotel.priceLevel,
      photoUrl: selectedHotel.photoUrl,
      insights: insightsById[selectedHotel.id] ?? null,
    });
    onClose();
  }, [selectedHotel, onSelect, onClose, region, insightsById]);

  const handleManualSave = useCallback(async () => {
    if (!customInput.name || !customInput.address) return;
    setCustomSaving(true);
    try {
      const latlng = await forwardGeocode(customInput.address);
      onSelect({
        id: `custom-${Date.now()}`,
        name: customInput.name,
        summary: customInput.notes || "직접 입력한 숙소",
        area: customInput.address,
        latlng: latlng ?? [35.68, 139.77],
        checkIn: customInput.checkIn,
        checkOut: customInput.checkOut,
        notes: customInput.notes,
        isCustom: true,
      });
      onClose();
    } finally {
      setCustomSaving(false);
    }
  }, [customInput, onSelect, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="hotel-modal-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="hotel-modal"
            initial={{ y: 40, scale: 0.96, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 40, scale: 0.96, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* ─── Header with tabs ───────────────────────── */}
            <div className="hotel-modal__header">
              <div className="hotel-modal__tabs">
                <button
                  type="button"
                  className={`hotel-modal__tab${tab === "browse" ? " active" : ""}`}
                  onClick={() => setTab("browse")}
                >
                  🤖 AI 추천 호텔
                </button>
                <button
                  type="button"
                  className={`hotel-modal__tab${tab === "manual" ? " active" : ""}`}
                  onClick={() => setTab("manual")}
                >
                  ✏️ 직접 입력
                </button>
              </div>
              <button type="button" className="hotel-modal__close" onClick={onClose} title="닫기 (ESC)">
                &times;
              </button>
            </div>

            {/* ─── Body ───────────────────────────────────── */}
            <div className="hotel-modal__body">
              {tab === "browse" && (
                <>
                  <div className="hotel-modal__list-col">
                    <div className="hotel-modal__search">
                      <input
                        type="text"
                        placeholder={`${region || "지역"} 호텔 검색…`}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleSearch();
                        }}
                      />
                      <button type="button" onClick={handleSearch} title="검색">
                        🔍
                      </button>
                      <button
                        type="button"
                        className={`hotel-modal__fav-filter${showFavOnly ? " active" : ""}`}
                        onClick={() => setShowFavOnly((v) => !v)}
                        title={showFavOnly ? "전체 호텔 보기" : "즐겨찾기만 보기"}
                      >
                        {showFavOnly ? "★" : "☆"}
                        <span className="hotel-modal__fav-count">{favorites.length}</span>
                      </button>
                    </div>
                    <div className="hotel-modal__filters">
                      <button
                        type="button"
                        className={`hotel-modal__filter-chip${activeFilter === null ? " active" : ""}`}
                        onClick={() => setActiveFilter(null)}
                      >전체</button>
                      {FILTER_TAGS.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          className={`hotel-modal__filter-chip${activeFilter === tag ? " active" : ""}`}
                          onClick={() => setActiveFilter(activeFilter === tag ? null : tag)}
                        >{tag}</button>
                      ))}
                      {insightsLoading && (
                        <span className="hotel-modal__filters-loading">AI 분석중…</span>
                      )}
                    </div>
                    <div className="hotel-modal__list">
                      {loading && (
                        <div className="hotel-modal__empty">
                          <span className="var-chat__dots">
                            <span /><span /><span />
                          </span>
                          <span>호텔 검색 중…</span>
                        </div>
                      )}
                      {!loading && visibleHotels.length === 0 && (
                        <div className="hotel-modal__empty">
                          <p>{showFavOnly ? "즐겨찾기에 저장된 호텔이 없어요." : "검색 결과가 없어요."}</p>
                          <p className="hotel-modal__empty-sub">
                            {showFavOnly ? "★ 버튼으로 호텔을 즐겨찾기에 추가해보세요." : "다른 검색어를 시도해보세요."}
                          </p>
                        </div>
                      )}
                      {!loading &&
                        visibleHotels.map((h) => {
                          const isActive = selectedHotel?.id === h.id;
                          const isFav = favorites.includes(h.id);
                          return (
                            <div
                              key={h.id}
                              role="button"
                              tabIndex={0}
                              className={`hotel-modal__card${isActive ? " active" : ""}`}
                              onClick={() => setSelectedHotel(h)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  setSelectedHotel(h);
                                }
                              }}
                            >
                              {h.photoUrl ? (
                                <img src={h.photoUrl} alt={h.name} />
                              ) : (
                                <div className="hotel-modal__card-nophoto">🏨</div>
                              )}
                              <div className="hotel-modal__card-body">
                                <strong className="hotel-modal__card-name">{h.name}</strong>
                                <div className="hotel-modal__card-meta">
                                  {h.rating != null && (
                                    <span className="hotel-modal__card-rating">
                                      ★ {Number(h.rating).toFixed(1)}
                                      {h.ratingCount ? ` (${h.ratingCount})` : ""}
                                    </span>
                                  )}
                                  {priceLevelLabel(h.priceLevel) && (
                                    <span className="hotel-modal__card-price">
                                      {priceLevelLabel(h.priceLevel)}
                                    </span>
                                  )}
                                </div>
                                <span className="hotel-modal__card-addr">{h.address}</span>
                                {h.insights && (
                                  <div className="hotel-modal__card-insights">
                                    <div className="hotel-modal__card-tagline">
                                      {h.insights.priceRange && (
                                        <span className="hotel-modal__card-pricerange">💴 {h.insights.priceRange}</span>
                                      )}
                                      {h.insights.tags?.slice(0, 3).map((t) => (
                                        <span key={t} className="hotel-modal__card-tag">#{t}</span>
                                      ))}
                                    </div>
                                    {h.insights.pros?.length > 0 && (
                                      <div className="hotel-modal__card-pros">
                                        <span className="hotel-modal__card-pros-icon">✓</span>
                                        {h.insights.pros.join(" · ")}
                                      </div>
                                    )}
                                    {h.insights.cons?.length > 0 && (
                                      <div className="hotel-modal__card-cons">
                                        <span className="hotel-modal__card-cons-icon">△</span>
                                        {h.insights.cons.join(" · ")}
                                      </div>
                                    )}
                                  </div>
                                )}
                                <div className="hotel-modal__card-book">
                                  <a
                                    href={bookingSearchUrl(h)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="hotel-modal__book-btn hotel-modal__book-btn--booking"
                                    onClick={(e) => e.stopPropagation()}
                                    title="Booking.com 에서 검색"
                                  >Booking</a>
                                  <a
                                    href={agodaSearchUrl(h)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="hotel-modal__book-btn hotel-modal__book-btn--agoda"
                                    onClick={(e) => e.stopPropagation()}
                                    title="Agoda 에서 검색"
                                  >Agoda</a>
                                  <a
                                    href={googleMapsUrl(h)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="hotel-modal__book-btn"
                                    onClick={(e) => e.stopPropagation()}
                                    title="Google Maps 에서 보기"
                                  >Maps</a>
                                </div>
                              </div>
                              <button
                                type="button"
                                className={`hotel-modal__fav-btn${isFav ? " active" : ""}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleFavorite(h.id);
                                }}
                                title={isFav ? "즐겨찾기 해제" : "즐겨찾기 추가"}
                                aria-label="즐겨찾기"
                              >{isFav ? "★" : "☆"}</button>
                            </div>
                          );
                        })}
                    </div>
                  </div>
                  <div className="hotel-modal__map-col">
                    <GoogleMapView
                      center={selectedHotel?.latlng ?? visibleHotels[0]?.latlng ?? [35.68, 139.77]}
                      zoom={13}
                      markers={visibleHotels
                        .filter((h) => h.latlng)
                        .map((h) => ({
                          id: h.id,
                          lat: h.latlng[0],
                          lng: h.latlng[1],
                          title: h.name,
                        }))}
                      onMarkerClick={(id) =>
                        setSelectedHotel(visibleHotels.find((h) => h.id === id) ?? null)
                      }
                    />
                  </div>
                </>
              )}

              {tab === "manual" && (
                <div className="hotel-modal__form">
                  <p className="hotel-modal__form-hint">
                    이미 예약한 숙소가 있다면 여기에 정보를 입력하세요. 이 숙소가
                    여행 플래너의 기준점으로 사용됩니다.
                  </p>
                  <label>
                    <span>호텔 이름 <em>*</em></span>
                    <input
                      type="text"
                      placeholder="예: 신주쿠 그랜드 호텔"
                      value={customInput.name}
                      onChange={(e) =>
                        setCustomInput((v) => ({ ...v, name: e.target.value }))
                      }
                    />
                  </label>
                  <label>
                    <span>주소 <em>*</em></span>
                    <input
                      type="text"
                      placeholder="도쿄도 신주쿠구 …"
                      value={customInput.address}
                      onChange={(e) =>
                        setCustomInput((v) => ({ ...v, address: e.target.value }))
                      }
                    />
                  </label>
                  <div className="hotel-modal__form-row">
                    <label>
                      <span>체크인</span>
                      <input
                        type="date"
                        value={customInput.checkIn}
                        onChange={(e) =>
                          setCustomInput((v) => ({ ...v, checkIn: e.target.value }))
                        }
                      />
                    </label>
                    <label>
                      <span>체크아웃</span>
                      <input
                        type="date"
                        value={customInput.checkOut}
                        onChange={(e) =>
                          setCustomInput((v) => ({ ...v, checkOut: e.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <label>
                    <span>메모 (선택)</span>
                    <textarea
                      rows={3}
                      placeholder="예약번호, 체크인 시간, 기타 메모"
                      value={customInput.notes}
                      onChange={(e) =>
                        setCustomInput((v) => ({ ...v, notes: e.target.value }))
                      }
                    />
                  </label>
                </div>
              )}
            </div>

            {/* ─── Footer ─────────────────────────────────── */}
            <div className="hotel-modal__footer">
              <button type="button" className="btn ghost" onClick={onClose}>
                취소
              </button>
              {tab === "browse" ? (
                <button
                  type="button"
                  className="btn primary"
                  onClick={handleBrowseSelect}
                  disabled={!selectedHotel}
                >
                  {selectedHotel
                    ? `"${selectedHotel.name}" 으로 결정 →`
                    : "호텔을 선택해주세요"}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn primary"
                  onClick={handleManualSave}
                  disabled={
                    !customInput.name || !customInput.address || customSaving
                  }
                >
                  {customSaving ? "저장 중…" : "저장 →"}
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
