use crate::{
    domain::{AppError, AppResult, ImageConversion, ImageConvertRequest, ImageFormatInfo},
    file_detection, file_io, security,
};
use image::codecs::{
    jpeg::JpegEncoder,
    pnm::{PnmEncoder, PnmSubtype, SampleEncoding},
    tga::TgaEncoder,
};
use image::{DynamicImage, ExtendedColorType, ImageFormat, ImageReader, Limits, RgbaImage};
use std::{io::Cursor, path::Path};

pub const MAX_INPUT_BYTES: u64 = 80 * 1024 * 1024;
pub const MAX_PIXELS: u64 = 100_000_000;
const MAX_DIMENSION: u32 = 20_000;
const MAX_OUTPUT_BYTES: usize = 128 * 1024 * 1024;
const MAX_DECODER_ALLOC: u64 = 512 * 1024 * 1024;
const ICO_MAX_SIDE: u32 = 256;
const DEFAULT_QUALITY: u8 = 90;

/// One selectable conversion target. The frontend builds its menu from this
/// list so the UI can never offer a format the encoder does not support.
#[derive(Debug)]
struct Target {
    id: &'static str,
    label: &'static str,
    extension: &'static str,
    format: ImageFormat,
    lossy: bool,
    alpha: bool,
}

const TARGETS: &[Target] = &[
    Target {
        id: "png",
        label: "PNG",
        extension: "png",
        format: ImageFormat::Png,
        lossy: false,
        alpha: true,
    },
    Target {
        id: "jpeg",
        label: "JPEG",
        extension: "jpg",
        format: ImageFormat::Jpeg,
        lossy: true,
        alpha: false,
    },
    Target {
        id: "webp",
        label: "WebP (lossless)",
        extension: "webp",
        format: ImageFormat::WebP,
        lossy: false,
        alpha: true,
    },
    Target {
        id: "gif",
        label: "GIF",
        extension: "gif",
        format: ImageFormat::Gif,
        lossy: false,
        alpha: true,
    },
    Target {
        id: "bmp",
        label: "BMP",
        extension: "bmp",
        format: ImageFormat::Bmp,
        lossy: false,
        alpha: true,
    },
    Target {
        id: "ico",
        label: "ICO icon",
        extension: "ico",
        format: ImageFormat::Ico,
        lossy: false,
        alpha: true,
    },
    Target {
        id: "tiff",
        label: "TIFF",
        extension: "tiff",
        format: ImageFormat::Tiff,
        lossy: false,
        alpha: true,
    },
    Target {
        id: "tga",
        label: "TGA",
        extension: "tga",
        format: ImageFormat::Tga,
        lossy: false,
        alpha: true,
    },
    Target {
        id: "qoi",
        label: "QOI",
        extension: "qoi",
        format: ImageFormat::Qoi,
        lossy: false,
        alpha: true,
    },
    Target {
        id: "pnm",
        label: "PPM (Netpbm)",
        extension: "ppm",
        format: ImageFormat::Pnm,
        lossy: false,
        alpha: false,
    },
];

pub fn formats() -> Vec<ImageFormatInfo> {
    TARGETS
        .iter()
        .map(|target| ImageFormatInfo {
            id: target.id.to_owned(),
            label: target.label.to_owned(),
            extension: target.extension.to_owned(),
            lossy: target.lossy,
            alpha: target.alpha,
        })
        .collect()
}

fn target_for(id: &str) -> AppResult<&'static Target> {
    TARGETS
        .iter()
        .find(|target| target.id.eq_ignore_ascii_case(id))
        .ok_or_else(|| {
            AppError::new(
                "unsupported_image_format",
                format!("{id} is not a supported conversion target"),
            )
        })
}

pub fn convert(request: &ImageConvertRequest) -> AppResult<ImageConversion> {
    let target = target_for(&request.format)?;
    let source = security::canonical_file(&request.source_path)?;
    let source_bytes = std::fs::metadata(&source)
        .map_err(|error| AppError::io(error, &source))?
        .len();
    if source_bytes > MAX_INPUT_BYTES {
        return Err(AppError::path(
            "image_size_limit",
            "Image exceeds the 80 MiB conversion limit",
            &source,
        ));
    }

    let image = decode(&source)?;
    let (width, height) = (image.width(), image.height());
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(AppError::new(
            "image_pixel_limit",
            "Image exceeds the 100 megapixel conversion limit",
        ));
    }
    if target.format == ImageFormat::Ico && (width > ICO_MAX_SIDE || height > ICO_MAX_SIDE) {
        return Err(AppError::new(
            "ico_dimension_limit",
            format!("ICO files are limited to {ICO_MAX_SIDE}x{ICO_MAX_SIDE}; this image is {width}x{height}"),
        ));
    }

    let background = parse_background(request.background.as_deref())?;
    let encoded = encode(
        image,
        target,
        request.quality.unwrap_or(DEFAULT_QUALITY),
        background,
    )?;

    let destination = security::destination_file(&request.destination_path)?;
    ensure_extension(&destination, target)?;
    file_io::atomic_save_bytes(&destination, &encoded)?;
    Ok(ImageConversion {
        file: file_detection::detect(destination)?,
        width,
        height,
        source_bytes,
        output_bytes: encoded.len() as u64,
    })
}

/// Decodes any supported raster format, rasterizing SVG through resvg because
/// the image crate has no vector decoder.
fn decode(path: &Path) -> AppResult<DynamicImage> {
    let bytes = std::fs::read(path).map_err(|error| AppError::io(error, path))?;
    if is_svg(&bytes) {
        return rasterize_svg(&bytes);
    }
    let mut reader = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|error| AppError::io(error, path))?;
    // TGA and friends carry no leading signature, so fall back to the extension
    // exactly like file detection does: content first, extension last.
    if reader.format().is_none() {
        let format = path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .and_then(ImageFormat::from_extension)
            .ok_or_else(|| {
                AppError::path(
                    "invalid_image",
                    "The image format could not be determined",
                    path,
                )
            })?;
        reader.set_format(format);
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(MAX_DECODER_ALLOC);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|error| AppError::path("invalid_image", error.to_string(), path))
}

fn is_svg(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(1024)];
    let text = String::from_utf8_lossy(head);
    let trimmed = text.trim_start_matches('\u{feff}').trim_start();
    trimmed.starts_with("<svg") || (trimmed.starts_with("<?xml") && text.contains("<svg"))
}

/// Renders SVG at its intrinsic size. External `href` targets are refused so a
/// hostile drawing cannot pull in local files, and no network access exists.
fn rasterize_svg(bytes: &[u8]) -> AppResult<DynamicImage> {
    let mut options = resvg::usvg::Options {
        resources_dir: None,
        ..Default::default()
    };
    options.image_href_resolver.resolve_string = Box::new(|_, _| None);
    options.fontdb_mut().load_system_fonts();
    let tree = resvg::usvg::Tree::from_data(bytes, &options)
        .map_err(|error| AppError::new("invalid_image", error.to_string()))?;
    let size = tree.size().to_int_size();
    let (width, height) = (size.width(), size.height());
    if width == 0 || height == 0 {
        return Err(AppError::new(
            "invalid_image",
            "The drawing has no rendered size",
        ));
    }
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(AppError::new(
            "image_pixel_limit",
            "Drawing exceeds the 100 megapixel conversion limit",
        ));
    }
    let mut pixmap = tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| AppError::new("invalid_image", "Could not allocate the drawing surface"))?;
    resvg::render(&tree, tiny_skia::Transform::default(), &mut pixmap.as_mut());
    // tiny-skia stores premultiplied alpha; the image crate expects straight alpha.
    let mut buffer = Vec::with_capacity(pixmap.pixels().len() * 4);
    for pixel in pixmap.pixels() {
        let color = pixel.demultiply();
        buffer.extend_from_slice(&[color.red(), color.green(), color.blue(), color.alpha()]);
    }
    let rgba = RgbaImage::from_raw(width, height, buffer)
        .ok_or_else(|| AppError::new("invalid_image", "The rendered drawing was incomplete"))?;
    Ok(DynamicImage::ImageRgba8(rgba))
}

fn encode(
    image: DynamicImage,
    target: &Target,
    quality: u8,
    background: [u8; 3],
) -> AppResult<Vec<u8>> {
    let image = if target.alpha {
        DynamicImage::ImageRgba8(image.to_rgba8())
    } else {
        DynamicImage::ImageRgb8(flatten(&image.to_rgba8(), background))
    };
    let (width, height) = (image.width(), image.height());
    let mut output = Cursor::new(Vec::new());
    let result = match target.format {
        ImageFormat::Jpeg => JpegEncoder::new_with_quality(&mut output, quality.clamp(1, 100))
            .encode_image(&image)
            .map_err(|error| error.to_string()),
        // The default TGA encoder emits RLE packets that cross scanline
        // boundaries, which strict readers reject; uncompressed is portable.
        ImageFormat::Tga => TgaEncoder::new(&mut output)
            .disable_rle()
            .encode(image.as_bytes(), width, height, colour_type(target))
            .map_err(|error| error.to_string()),
        // The default PNM subtype is P7/PAM, which little else reads. A file
        // named .ppm must actually be a P6 pixmap.
        ImageFormat::Pnm => PnmEncoder::new(&mut output)
            .with_subtype(PnmSubtype::Pixmap(SampleEncoding::Binary))
            .encode(image.as_bytes(), width, height, colour_type(target))
            .map_err(|error| error.to_string()),
        format => image
            .write_to(&mut output, format)
            .map_err(|error| error.to_string()),
    };
    result.map_err(|message| AppError::new("image_encode_failed", message))?;
    let encoded = output.into_inner();
    if encoded.len() > MAX_OUTPUT_BYTES {
        return Err(AppError::new(
            "image_output_limit",
            "The converted image exceeds the 128 MiB output limit",
        ));
    }
    Ok(encoded)
}

/// Composites transparency onto a solid colour for formats without an alpha
/// channel, so a transparent PNG does not turn into a black JPEG.
fn flatten(source: &RgbaImage, background: [u8; 3]) -> image::RgbImage {
    let mut output = image::RgbImage::new(source.width(), source.height());
    for (target, pixel) in output.pixels_mut().zip(source.pixels()) {
        let alpha = f32::from(pixel[3]) / 255.0;
        *target = image::Rgb([
            blend(pixel[0], background[0], alpha),
            blend(pixel[1], background[1], alpha),
            blend(pixel[2], background[2], alpha),
        ]);
    }
    output
}

/// The buffer handed to the low-level encoders always matches what `encode`
/// normalised the image to just above.
fn colour_type(target: &Target) -> ExtendedColorType {
    if target.alpha {
        ExtendedColorType::Rgba8
    } else {
        ExtendedColorType::Rgb8
    }
}

fn blend(foreground: u8, background: u8, alpha: f32) -> u8 {
    (f32::from(foreground) * alpha + f32::from(background) * (1.0 - alpha)).round() as u8
}

fn parse_background(value: Option<&str>) -> AppResult<[u8; 3]> {
    let Some(value) = value else {
        return Ok([255, 255, 255]);
    };
    let digits = value.trim().trim_start_matches('#');
    if digits.len() != 6 {
        return Err(AppError::new(
            "invalid_background",
            "Background must be a #rrggbb colour",
        ));
    }
    let mut channels = [0u8; 3];
    for (index, channel) in channels.iter_mut().enumerate() {
        *channel = u8::from_str_radix(&digits[index * 2..index * 2 + 2], 16).map_err(|_| {
            AppError::new("invalid_background", "Background must be a #rrggbb colour")
        })?;
    }
    Ok(channels)
}

/// The saved file must carry an extension the chosen encoder actually produces,
/// so a converted image never lies about its contents.
fn ensure_extension(destination: &Path, target: &Target) -> AppResult<()> {
    let extension = destination
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    let accepted = target.format.extensions_str();
    match extension {
        Some(value) if accepted.contains(&value.as_str()) => Ok(()),
        _ => Err(AppError::path(
            "invalid_image_destination",
            format!(
                "A {} file must be saved with a .{} extension",
                target.label, target.extension
            ),
            destination,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use assert_fs::{fixture::PathChild, TempDir};

    fn sample() -> DynamicImage {
        let mut image = RgbaImage::new(4, 2);
        for (index, pixel) in image.pixels_mut().enumerate() {
            *pixel = image::Rgba([255, 0, 0, if index < 4 { 0 } else { 255 }]);
        }
        DynamicImage::ImageRgba8(image)
    }

    #[test]
    fn every_advertised_target_encodes() {
        for target in TARGETS {
            let encoded = encode(sample(), target, DEFAULT_QUALITY, [255, 255, 255])
                .unwrap_or_else(|error| panic!("{} failed: {error}", target.id));
            assert!(!encoded.is_empty(), "{} produced no bytes", target.id);
        }
        assert_eq!(formats().len(), TARGETS.len());
    }

    #[test]
    fn transparency_is_composited_onto_the_background() {
        let flattened = flatten(&sample().to_rgba8(), [0, 0, 255]);
        assert_eq!(
            flattened.get_pixel(0, 0).0,
            [0, 0, 255],
            "clear pixel kept its own colour"
        );
        assert_eq!(
            flattened.get_pixel(0, 1).0,
            [255, 0, 0],
            "opaque pixel was altered"
        );
    }

    #[test]
    fn half_transparent_pixels_blend_both_ways() {
        assert_eq!(blend(0, 255, 0.5), 128);
        assert_eq!(blend(255, 0, 1.0), 255);
        assert_eq!(blend(255, 0, 0.0), 0);
    }

    #[test]
    fn background_colours_are_validated() {
        assert_eq!(parse_background(None).unwrap(), [255, 255, 255]);
        assert_eq!(parse_background(Some("#0a141e")).unwrap(), [10, 20, 30]);
        assert_eq!(parse_background(Some("102030")).unwrap(), [16, 32, 48]);
        assert_eq!(
            parse_background(Some("#fff")).unwrap_err().code,
            "invalid_background"
        );
        assert_eq!(
            parse_background(Some("#gggggg")).unwrap_err().code,
            "invalid_background"
        );
    }

    #[test]
    fn destination_extension_must_match_the_encoder() {
        let png = target_for("png").unwrap();
        assert!(ensure_extension(Path::new("a/b.png"), png).is_ok());
        assert!(
            ensure_extension(Path::new("a/b.PNG"), png).is_ok(),
            "extension case is normalised"
        );
        assert_eq!(
            ensure_extension(Path::new("a/b.jpg"), png)
                .unwrap_err()
                .code,
            "invalid_image_destination"
        );
        let jpeg = target_for("jpeg").unwrap();
        assert!(
            ensure_extension(Path::new("a/b.jpeg"), jpeg).is_ok(),
            "both JPEG extensions are accepted"
        );
        assert!(ensure_extension(Path::new("a/b.jpg"), jpeg).is_ok());
    }

    /// Both of these were caught by reading converted files back with an
    /// unrelated decoder: the crate defaults produce a P7/PAM file behind a
    /// .ppm name, and RLE TGA that strict readers reject.
    #[test]
    fn ppm_and_tga_are_written_in_their_portable_forms() {
        let ppm = encode(sample(), target_for("pnm").unwrap(), 90, [255, 255, 255]).unwrap();
        assert_eq!(
            &ppm[..2],
            b"P6",
            "a .ppm file must be a P6 pixmap, not P7/PAM"
        );

        let tga = encode(sample(), target_for("tga").unwrap(), 90, [255, 255, 255]).unwrap();
        assert_eq!(
            tga[2], 2,
            "TGA image type must be uncompressed true-colour, not RLE"
        );
    }

    #[test]
    fn formats_without_a_leading_signature_fall_back_to_the_extension() {
        let directory = TempDir::new().unwrap();
        let file = directory.child("headerless.tga");
        let encoded = encode(sample(), target_for("tga").unwrap(), 90, [255, 255, 255]).unwrap();
        std::fs::write(file.path(), &encoded).unwrap();
        let decoded = decode(file.path()).expect("TGA has no magic bytes to guess from");
        assert_eq!((decoded.width(), decoded.height()), (4, 2));

        let unknown = directory.child("mystery.bin");
        std::fs::write(unknown.path(), &encoded).unwrap();
        assert_eq!(decode(unknown.path()).unwrap_err().code, "invalid_image");
    }

    #[test]
    fn unknown_targets_are_rejected() {
        assert_eq!(
            target_for("avif").unwrap_err().code,
            "unsupported_image_format"
        );
    }

    #[test]
    fn svg_is_detected_and_rasterized_without_external_access() {
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="6" height="4"><rect width="6" height="4" fill="#ff0000"/><image href="/etc/passwd" width="6" height="4"/></svg>"##;
        assert!(is_svg(svg));
        let rendered = rasterize_svg(svg).unwrap();
        assert_eq!((rendered.width(), rendered.height()), (6, 4));
        assert_eq!(rendered.to_rgba8().get_pixel(0, 0).0, [255, 0, 0, 255]);
    }

    #[test]
    fn converts_a_real_file_end_to_end() {
        let directory = TempDir::new().unwrap();
        let source = directory.child("source.png");
        let destination = directory.child("converted.jpg");
        sample().save(source.path()).unwrap();
        let result = convert(&ImageConvertRequest {
            source_path: source.path().to_string_lossy().into_owned(),
            destination_path: destination.path().to_string_lossy().into_owned(),
            format: "jpeg".into(),
            quality: Some(80),
            background: Some("#000000".into()),
        })
        .unwrap();
        assert_eq!((result.width, result.height), (4, 2));
        assert!(result.output_bytes > 0);
        assert_eq!(result.file.handler_id, "image");
        let written = ImageReader::open(destination.path())
            .unwrap()
            .with_guessed_format()
            .unwrap()
            .decode()
            .unwrap();
        assert_eq!((written.width(), written.height()), (4, 2));
    }

    #[test]
    fn refuses_a_destination_that_contradicts_the_format() {
        let directory = TempDir::new().unwrap();
        let source = directory.child("source.png");
        sample().save(source.path()).unwrap();
        let error = convert(&ImageConvertRequest {
            source_path: source.path().to_string_lossy().into_owned(),
            destination_path: directory
                .child("wrong.png")
                .path()
                .to_string_lossy()
                .into_owned(),
            format: "jpeg".into(),
            quality: None,
            background: None,
        })
        .unwrap_err();
        assert_eq!(error.code, "invalid_image_destination");
        assert!(
            !directory.child("wrong.png").path().exists(),
            "nothing was written"
        );
    }

    #[test]
    fn missing_and_corrupt_sources_stay_structured() {
        let directory = TempDir::new().unwrap();
        let broken = directory.child("broken.png");
        std::fs::write(broken.path(), b"not an image").unwrap();
        let request = |path: String| ImageConvertRequest {
            source_path: path,
            destination_path: directory
                .child("out.png")
                .path()
                .to_string_lossy()
                .into_owned(),
            format: "png".into(),
            quality: None,
            background: None,
        };
        assert_eq!(
            convert(&request("missing-oneopen-image.png".into()))
                .unwrap_err()
                .code,
            "file_not_found"
        );
        assert_eq!(
            convert(&request(broken.path().to_string_lossy().into_owned()))
                .unwrap_err()
                .code,
            "invalid_image"
        );
    }
}
