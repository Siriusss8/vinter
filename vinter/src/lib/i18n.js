// UI strings, keyed by the language of the Vinted page (<html lang>), not the browser.
(function (root) {
  'use strict';
  const V = (root.Vinter = root.Vinter || {});

  const STRINGS = {
    en: {
      chip: 'Seller',
      panel: 'Seller filters',
      any: 'Any',
      atLeast: 'At least {x}',
      within: 'Within {x}',
      reviewsTitle: 'Minimum reviews',
      reviewsDesc: 'Hide sellers with fewer reviews.',
      ratingTitle: 'Minimum rating',
      ratingDesc: 'Applies to sellers with at least one review.',
      ageTitle: 'Account age',
      ageDesc: 'Estimated from the account ID. Hides newer accounts.',
      activeTitle: 'Last seen',
      activeDesc: 'Hide sellers inactive for longer than this.',
      recentTitle: 'Recent reviews',
      recentDesc: 'Average of the 10 latest written reviews. Costs one extra request per seller.',
      photosTitle: 'Reused photos',
      photosDesc: "Experimental. Flags listings whose cover photo matches another seller's listing.",
      modeTitle: 'Filtered listings',
      hide: 'Hide',
      dim: 'Dim',
      reset: 'Reset',
      done: 'Done',
      statusOff: 'No seller filters active.',
      status: '{hidden} filtered · {pending} sellers to check',
      statusNext: 'next page: {pending} to check',
      statusNextReady: 'next page ready',
      statusPaused: 'Vinted is rate-limiting requests; retrying shortly.',
      rReviews: '{n} reviews',
      rReviewsOne: '1 review',
      rRating: '{x}',
      rAge: 'New account (~{x})',
      rInactive: 'Inactive {x}',
      rRecent: 'Recent {x}',
      rPhoto: 'Reused photo',
    },
    it: {
      chip: 'Venditore',
      panel: 'Filtri venditore',
      any: 'Qualsiasi',
      atLeast: 'Almeno {x}',
      within: 'Entro {x}',
      reviewsTitle: 'Recensioni minime',
      reviewsDesc: 'Nascondi i venditori con meno recensioni.',
      ratingTitle: 'Valutazione minima',
      ratingDesc: 'Si applica ai venditori con almeno una recensione.',
      ageTitle: 'Anzianità account',
      ageDesc: "Stimata dall'ID dell'account. Nasconde gli account più recenti.",
      activeTitle: 'Ultimo accesso',
      activeDesc: 'Nascondi i venditori inattivi da più tempo.',
      recentTitle: 'Recensioni recenti',
      recentDesc: 'Media delle ultime 10 recensioni scritte. Richiede una richiesta in più per venditore.',
      photosTitle: 'Foto riutilizzate',
      photosDesc: "Sperimentale. Segnala gli annunci la cui foto principale coincide con quella di un altro venditore.",
      modeTitle: 'Annunci filtrati',
      hide: 'Nascondi',
      dim: 'Attenua',
      reset: 'Reimposta',
      done: 'Fatto',
      statusOff: 'Nessun filtro venditore attivo.',
      status: '{hidden} filtrati · {pending} venditori da verificare',
      statusNext: 'pagina successiva: {pending} da verificare',
      statusNextReady: 'pagina successiva pronta',
      statusPaused: 'Vinted sta limitando le richieste; nuovo tentativo a breve.',
      rReviews: '{n} recensioni',
      rReviewsOne: '1 recensione',
      rRating: '{x}',
      rAge: 'Account nuovo (~{x})',
      rInactive: 'Inattivo da {x}',
      rRecent: 'Recenti {x}',
      rPhoto: 'Foto riutilizzata',
    },
    fr: {
      chip: 'Vendeur',
      panel: 'Filtres vendeur',
      any: 'Tous',
      atLeast: 'Au moins {x}',
      within: 'Moins de {x}',
      reviewsTitle: "Nombre d'avis minimum",
      reviewsDesc: "Masquer les vendeurs ayant moins d'avis.",
      ratingTitle: 'Note minimale',
      ratingDesc: "S'applique aux vendeurs ayant au moins un avis.",
      ageTitle: 'Ancienneté du compte',
      ageDesc: "Estimée à partir de l'identifiant du compte. Masque les comptes plus récents.",
      activeTitle: 'Dernière connexion',
      activeDesc: 'Masquer les vendeurs inactifs depuis plus longtemps.',
      recentTitle: 'Avis récents',
      recentDesc: 'Moyenne des 10 derniers avis rédigés. Une requête supplémentaire par vendeur.',
      photosTitle: 'Photos réutilisées',
      photosDesc: "Expérimental. Signale les annonces dont la photo principale correspond à celle d'un autre vendeur.",
      modeTitle: 'Annonces filtrées',
      hide: 'Masquer',
      dim: 'Estomper',
      reset: 'Réinitialiser',
      done: 'Terminé',
      statusOff: 'Aucun filtre vendeur actif.',
      status: '{hidden} filtrées · {pending} vendeurs à vérifier',
      statusNext: 'page suivante : {pending} à vérifier',
      statusNextReady: 'page suivante prête',
      statusPaused: 'Vinted limite les requêtes ; nouvel essai sous peu.',
      rReviews: '{n} avis',
      rReviewsOne: '1 avis',
      rRating: '{x}',
      rAge: 'Compte récent (~{x})',
      rInactive: 'Inactif depuis {x}',
      rRecent: 'Récents {x}',
      rPhoto: 'Photo réutilisée',
    },
    de: {
      chip: 'Verkäufer',
      panel: 'Verkäuferfilter',
      any: 'Alle',
      atLeast: 'Mindestens {x}',
      within: 'Innerhalb von {x}',
      reviewsTitle: 'Mindestanzahl Bewertungen',
      reviewsDesc: 'Verkäufer mit weniger Bewertungen ausblenden.',
      ratingTitle: 'Mindestbewertung',
      ratingDesc: 'Gilt für Verkäufer mit mindestens einer Bewertung.',
      ageTitle: 'Kontoalter',
      ageDesc: 'Anhand der Konto-ID geschätzt. Blendet neuere Konten aus.',
      activeTitle: 'Zuletzt online',
      activeDesc: 'Verkäufer ausblenden, die länger inaktiv sind.',
      recentTitle: 'Aktuelle Bewertungen',
      recentDesc: 'Durchschnitt der 10 neuesten schriftlichen Bewertungen. Eine zusätzliche Anfrage pro Verkäufer.',
      photosTitle: 'Wiederverwendete Fotos',
      photosDesc: 'Experimentell. Markiert Artikel, deren Titelfoto mit dem Artikel eines anderen Verkäufers übereinstimmt.',
      modeTitle: 'Gefilterte Artikel',
      hide: 'Ausblenden',
      dim: 'Abblenden',
      reset: 'Zurücksetzen',
      done: 'Fertig',
      statusOff: 'Keine Verkäuferfilter aktiv.',
      status: '{hidden} gefiltert · {pending} Verkäufer zu prüfen',
      statusNext: 'nächste Seite: {pending} zu prüfen',
      statusNextReady: 'nächste Seite bereit',
      statusPaused: 'Vinted drosselt Anfragen; neuer Versuch in Kürze.',
      rReviews: '{n} Bewertungen',
      rReviewsOne: '1 Bewertung',
      rRating: '{x}',
      rAge: 'Neues Konto (~{x})',
      rInactive: 'Inaktiv seit {x}',
      rRecent: 'Aktuell {x}',
      rPhoto: 'Foto wiederverwendet',
    },
    es: {
      chip: 'Vendedor',
      panel: 'Filtros de vendedor',
      any: 'Cualquiera',
      atLeast: 'Al menos {x}',
      within: 'Menos de {x}',
      reviewsTitle: 'Valoraciones mínimas',
      reviewsDesc: 'Oculta vendedores con menos valoraciones.',
      ratingTitle: 'Puntuación mínima',
      ratingDesc: 'Se aplica a vendedores con al menos una valoración.',
      ageTitle: 'Antigüedad de la cuenta',
      ageDesc: 'Estimada a partir del ID de la cuenta. Oculta las cuentas más nuevas.',
      activeTitle: 'Última conexión',
      activeDesc: 'Oculta vendedores inactivos durante más tiempo.',
      recentTitle: 'Valoraciones recientes',
      recentDesc: 'Media de las 10 últimas valoraciones escritas. Una petición extra por vendedor.',
      photosTitle: 'Fotos reutilizadas',
      photosDesc: 'Experimental. Marca los artículos cuya foto principal coincide con la de otro vendedor.',
      modeTitle: 'Artículos filtrados',
      hide: 'Ocultar',
      dim: 'Atenuar',
      reset: 'Restablecer',
      done: 'Hecho',
      statusOff: 'No hay filtros de vendedor activos.',
      status: '{hidden} filtrados · {pending} vendedores por comprobar',
      statusNext: 'página siguiente: {pending} por comprobar',
      statusNextReady: 'página siguiente lista',
      statusPaused: 'Vinted está limitando las peticiones; se reintentará en breve.',
      rReviews: '{n} valoraciones',
      rReviewsOne: '1 valoración',
      rRating: '{x}',
      rAge: 'Cuenta nueva (~{x})',
      rInactive: 'Inactivo hace {x}',
      rRecent: 'Recientes {x}',
      rPhoto: 'Foto reutilizada',
    },
  };

  function detectLang(htmlLang) {
    const code = String(htmlLang || '').toLowerCase().split('-')[0];
    return STRINGS[code] ? code : 'en';
  }

  function translator(lang) {
    const table = STRINGS[lang] || STRINGS.en;
    return (key, vars) => {
      let s = table[key] ?? STRINGS.en[key] ?? key;
      if (vars) for (const k in vars) s = s.split(`{${k}}`).join(String(vars[k]));
      return s;
    };
  }

  // Durations use Intl unit formatting so they are localized without a dictionary.
  function formatDuration(days, lang) {
    let unit = 'day';
    let n = days;
    if (days >= 365) { unit = 'year'; n = days / 365.25; }
    else if (days >= 30) { unit = 'month'; n = days / 30.44; }
    n = Math.max(1, Math.round(n));
    try {
      return new Intl.NumberFormat(lang, { style: 'unit', unit, unitDisplay: 'long' }).format(n);
    } catch {
      return `${n} ${unit}${n === 1 ? '' : 's'}`;
    }
  }

  function formatRating(value, lang) {
    try {
      return new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value) + ' ★';
    } catch {
      return value.toFixed(1) + ' ★';
    }
  }

  V.i18n = { STRINGS, detectLang, translator, formatDuration, formatRating };
  if (typeof module === 'object' && module.exports) module.exports = V.i18n;
})(globalThis);
