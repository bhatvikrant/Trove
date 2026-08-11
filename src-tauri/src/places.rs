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
}
