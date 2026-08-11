use reverse_geocoder::ReverseGeocoder;
use std::sync::OnceLock;

static GEO: OnceLock<ReverseGeocoder> = OnceLock::new();

/// Nearest (city, country) for a coordinate, using a bundled offline dataset.
pub fn geocode(lat: f64, lon: f64) -> (Option<String>, Option<String>) {
    let geo = GEO.get_or_init(ReverseGeocoder::new);
    let result = geo.search((lat, lon));
    let city = if result.record.name.is_empty() {
        None
    } else {
        Some(result.record.name.clone())
    };
    let country = isocountry::CountryCode::for_alpha2(&result.record.cc)
        .ok()
        .map(|c| c.name().to_string())
        .or_else(|| {
            if result.record.cc.is_empty() {
                None
            } else {
                Some(result.record.cc.clone())
            }
        });
    (city, country)
}

/// The ISO 3166-1 alpha-2 code for a stored country name (e.g. "France" → "FR"),
/// so the UI can render the country's flag emoji. Names come from
/// `isocountry`, so the reverse match is exact; rows that fell back to a raw
/// 2-letter code are handled too.
pub fn alpha2_for_name(name: &str) -> Option<String> {
    if name.len() == 2 && name.chars().all(|c| c.is_ascii_alphabetic()) {
        return Some(name.to_ascii_uppercase());
    }
    isocountry::CountryCode::iter()
        .find(|c| c.name() == name)
        .map(|c| c.alpha2().to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn geocodes_known_places() {
        let (city, country) = super::geocode(48.8566, 2.3522); // Paris
        assert_eq!(country.as_deref(), Some("France"), "city={city:?}");
        assert!(city.is_some());

        let (_, country) = super::geocode(35.6895, 139.6917); // Tokyo
        assert_eq!(country.as_deref(), Some("Japan"));
    }

    #[test]
    fn maps_country_name_to_alpha2() {
        assert_eq!(super::alpha2_for_name("France").as_deref(), Some("FR"));
        assert_eq!(super::alpha2_for_name("India").as_deref(), Some("IN"));
        assert_eq!(super::alpha2_for_name("Japan").as_deref(), Some("JP"));
        assert_eq!(super::alpha2_for_name("Nowhereland"), None);
    }
}
