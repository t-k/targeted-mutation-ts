use std::{ptr, slice, str};

use swc_next_core::{
    BoolOr,
    js::{
        JsTransformApiOptions,
        transformer::{JsTransformerConfig, JsTypeScriptConfig, transform_js},
    },
};

// The Node adapter owns the input borrows for the duration of this call and owns the returned allocation on success.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn swc_next_compile(
    source: *const u8,
    size: usize,
    filename: *const u8,
    filename_size: usize,
    output_size: *mut usize,
) -> *mut u8 {
    let (Ok(source), Ok(filename)) = (
        str::from_utf8(unsafe { slice::from_raw_parts(source, size) }),
        str::from_utf8(unsafe { slice::from_raw_parts(filename, filename_size) }),
    ) else {
        return ptr::null_mut();
    };
    let options = JsTransformApiOptions {
        filename: Some(filename.to_owned()),
        transformer: Some(JsTransformerConfig {
            typescript: Some(BoolOr::Options(JsTypeScriptConfig {
                verbatim_module_syntax: Some(true),
                ..Default::default()
            })),
            ..Default::default()
        }),
        ..Default::default()
    };
    let result = transform_js::<true>(source, options);
    if !result.diagnostics.is_empty() {
        return ptr::null_mut();
    }
    let output = result.code.into_bytes().into_boxed_slice();
    unsafe { *output_size = output.len() };
    Box::into_raw(output).cast::<u8>()
}

// The pointer and length must come from the same successful swc_next_compile call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn swc_next_release(output: *mut u8, size: usize) {
    unsafe { drop(Box::from_raw(ptr::slice_from_raw_parts_mut(output, size))) }
}
