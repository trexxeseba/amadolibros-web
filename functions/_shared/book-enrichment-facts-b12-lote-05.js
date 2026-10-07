// Generado por scripts/seo/book-intelligence-project.mjs. NO EDITAR A MANO.
// Sólo hechos ausentes, verificados por ISBN exacto; sin datos comerciales.

export const BOOK_FACT_ENRICHMENTS = Object.freeze([
  {
    "schema_version": 1,
    "isbn": "9788410359239",
    "sample_listing_id": "MLU1504806406",
    "decision": "auto_publish_facts",
    "verified_at": "2026-09-25",
    "facts": {
      "publisher": "Newton Compton Editores",
      "pages": 443
    },
    "provenance": [
      {
        "type": "national_library",
        "provider": "Biblioteca Nacional de España",
        "url": "https://catalogo.bne.es/view/sru/34BNE_INST?operation=searchRetrieve&version=1.2&query=alma.isbn%3D%229788410359239%22&recordSchema=marcxml&startRecord=1&maximumRecords=5",
        "relationship": "exact_edition",
        "isbn": "9788410359239",
        "verified_at": "2026-09-25",
        "fields": [
          "pages",
          "publisher"
        ]
      }
    ]
  },
  {
    "schema_version": 1,
    "isbn": "9789874729095",
    "sample_listing_id": "MLU602259072",
    "decision": "auto_publish_facts",
    "verified_at": "2026-09-25",
    "facts": {
      "bibliographic": {
        "publication_year": "2019"
      }
    },
    "provenance": [
      {
        "type": "national_library",
        "provider": "Library of Congress",
        "url": "https://lccn.loc.gov/2020469271",
        "relationship": "exact_edition",
        "isbn": "9789874729095",
        "verified_at": "2026-09-25",
        "fields": [
          "publication_year"
        ]
      }
    ]
  }
]);
