//! Field value types and conversions.
//!
//! This module defines the [`FieldValue`] enum which represents all possible
//! types that entity properties can have.

use crate::error::FieldValueError;

/// Value type for entity properties.
///
/// This enum represents all possible types that can be stored in entity
/// properties. Use [`TryInto`] to convert to Rust types, or use the `property!`
/// macro for convenient access.
///
/// # Variants
///
/// - Numeric types: `i8`, `i16`, `i32`, `i64`, `u8`, `u16`, `u32`, `u64`
/// - Floating point: `f32`
/// - Text: `String`
/// - Vectors: 2D, 3D, and 4D float arrays
/// - Boolean: `bool`
///
/// # Examples
///
/// ## Manual conversion
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// # fn example(entity: &Entity) -> anyhow::Result<()> {
/// let field_value = entity.get_property_by_name("m_iHealth")?;
/// let health: i32 = field_value.try_into()?;
/// println!("Health: {}", health);
/// # Ok(())
/// # }
/// ```
///
/// ## Using property! macro
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// # fn example(entity: &Entity) -> anyhow::Result<()> {
/// // Type is inferred
/// let health: i32 = property!(entity, "m_iHealth");
/// # Ok(())
/// # }
/// ```
#[derive(Debug, Clone, PartialEq)]
pub enum FieldValue {
    /// Boolean value
    Boolean(bool),
    /// String value
    String(String),
    /// 32-bit floating point value
    Float(f32),

    /// 2D vector
    Vector2D([f32; 2]),
    /// 3D vector
    Vector3D([f32; 3]),
    /// 4D vector
    Vector4D([f32; 4]),

    /// Signed 8-bit integer
    Signed8(i8),
    /// Signed 16-bit integer
    Signed16(i16),
    /// Signed 32-bit integer
    Signed32(i32),
    /// Signed 64-bit integer
    Signed64(i64),

    /// Unsigned 8-bit integer
    Unsigned8(u8),
    /// Unsigned 16-bit integer
    Unsigned16(u16),
    /// Unsigned 32-bit integer
    Unsigned32(u32),
    /// Unsigned 64-bit integer
    Unsigned64(u64),
}

impl FieldValue {
    /// Returns the decoded value type name.
    pub fn type_name(&self) -> &'static str {
        match self {
            FieldValue::Boolean(_) => "Boolean",
            FieldValue::String(_) => "String",
            FieldValue::Float(_) => "Float",
            FieldValue::Vector2D(_) => "Vector2D",
            FieldValue::Vector3D(_) => "Vector3D",
            FieldValue::Vector4D(_) => "Vector4D",
            FieldValue::Signed8(_) => "Signed8",
            FieldValue::Signed16(_) => "Signed16",
            FieldValue::Signed32(_) => "Signed32",
            FieldValue::Signed64(_) => "Signed64",
            FieldValue::Unsigned8(_) => "Unsigned8",
            FieldValue::Unsigned16(_) => "Unsigned16",
            FieldValue::Unsigned32(_) => "Unsigned32",
            FieldValue::Unsigned64(_) => "Unsigned64",
        }
    }
}

/// Converts ordinary Rust values into [`FieldValue`] replacements.
pub trait IntoFieldValue {
    /// Converts this value into a [`FieldValue`].
    fn into_field_value(self) -> FieldValue;
}

/// Converts a field rewrite handler result into an optional replacement.
///
/// Returning a plain value replaces the field. Returning `Option<T>` allows a
/// handler to keep the original field by returning `None`.
pub trait FieldRewriteResult {
    /// Converts this handler result into an optional [`FieldValue`].
    fn into_field_rewrite_result(self) -> Option<FieldValue>;
}

impl<T> FieldRewriteResult for T
where
    T: IntoFieldValue,
{
    fn into_field_rewrite_result(self) -> Option<FieldValue> {
        Some(self.into_field_value())
    }
}

impl<T> FieldRewriteResult for Option<T>
where
    T: IntoFieldValue,
{
    fn into_field_rewrite_result(self) -> Option<FieldValue> {
        self.map(IntoFieldValue::into_field_value)
    }
}

impl IntoFieldValue for FieldValue {
    fn into_field_value(self) -> FieldValue {
        self
    }
}

impl IntoFieldValue for String {
    fn into_field_value(self) -> FieldValue {
        FieldValue::String(self)
    }
}

impl IntoFieldValue for &str {
    fn into_field_value(self) -> FieldValue {
        FieldValue::String(self.to_string())
    }
}

impl IntoFieldValue for bool {
    fn into_field_value(self) -> FieldValue {
        FieldValue::Boolean(self)
    }
}

impl IntoFieldValue for f32 {
    fn into_field_value(self) -> FieldValue {
        FieldValue::Float(self)
    }
}

impl IntoFieldValue for [f32; 2] {
    fn into_field_value(self) -> FieldValue {
        FieldValue::Vector2D(self)
    }
}

impl IntoFieldValue for [f32; 3] {
    fn into_field_value(self) -> FieldValue {
        FieldValue::Vector3D(self)
    }
}

impl IntoFieldValue for [f32; 4] {
    fn into_field_value(self) -> FieldValue {
        FieldValue::Vector4D(self)
    }
}

macro_rules! impl_into_field_value {
    ($($ty:ty => $variant:ident),* $(,)?) => {
        $(
            impl IntoFieldValue for $ty {
                fn into_field_value(self) -> FieldValue {
                    FieldValue::$variant(self)
                }
            }
        )*
    };
}

impl_into_field_value! {
    i8 => Signed8,
    i16 => Signed16,
    i32 => Signed32,
    i64 => Signed64,
    u8 => Unsigned8,
    u16 => Unsigned16,
    u32 => Unsigned32,
    u64 => Unsigned64,
}

impl TryInto<String> for FieldValue {
    type Error = FieldValueError;

    fn try_into(self) -> Result<String, FieldValueError> {
        if let FieldValue::String(x) = self {
            Ok(x)
        } else {
            Err(FieldValueError::ConversionError(
                format!("{:?}", self),
                "String".to_string(),
            ))
        }
    }
}

impl TryInto<String> for &FieldValue {
    type Error = FieldValueError;

    fn try_into(self) -> Result<String, FieldValueError> {
        if let FieldValue::String(x) = self {
            Ok(x.to_owned())
        } else {
            Err(FieldValueError::ConversionError(
                format!("{:?}", self),
                "String".to_string(),
            ))
        }
    }
}

impl TryInto<[f32; 2]> for FieldValue {
    type Error = FieldValueError;

    fn try_into(self) -> Result<[f32; 2], FieldValueError> {
        if let FieldValue::Vector2D(x) = self {
            Ok(x)
        } else {
            Err(FieldValueError::ConversionError(
                format!("{:?}", self),
                "[f32; 2]".to_string(),
            ))
        }
    }
}

impl TryInto<[f32; 2]> for &FieldValue {
    type Error = FieldValueError;

    fn try_into(self) -> Result<[f32; 2], FieldValueError> {
        if let FieldValue::Vector2D(x) = self {
            Ok(*x)
        } else {
            Err(FieldValueError::ConversionError(
                format!("{:?}", self),
                "[f32; 2]".to_string(),
            ))
        }
    }
}

impl TryInto<(f32, f32)> for FieldValue {
    type Error = FieldValueError;

    fn try_into(self) -> Result<(f32, f32), FieldValueError> {
        if let FieldValue::Vector2D(x) = self {
            Ok(x.into())
        } else {
            Err(FieldValueError::ConversionError(
                format!("{:?}", self),
                "(f32, f32)".to_string(),
            ))
        }
    }
}

impl TryInto<(f32, f32)> for &FieldValue {
    type Error = FieldValueError;

    fn try_into(self) -> Result<(f32, f32), FieldValueError> {
        if let FieldValue::Vector2D(x) = self {
            Ok((*x).into())
        } else {
            Err(FieldValueError::ConversionError(
                format!("{:?}", self),
                "(f32, f32)".to_string(),
            ))
        }
    }
}

impl TryInto<[f32; 3]> for FieldValue {
    type Error = FieldValueError;

    fn try_into(self) -> Result<[f32; 3], FieldValueError> {
        if let FieldValue::Vector3D(x) = self {
            Ok(x)
        } else {
            Err(FieldValueError::ConversionError(
                format!("{:?}", self),
                "[f32; 3]".to_string(),
            ))
        }
    }
}

impl TryInto<[f32; 3]> for &FieldValue {
    type Error = FieldValueError;

    fn try_into(self) -> Result<[f32; 3], FieldValueError> {
        if let FieldValue::Vector3D(x) = self {
            Ok(*x)
        } else {
            Err(FieldValueError::ConversionError(
                format!("{:?}", self),
                "[f32; 3]".to_string(),
            ))
        }
    }
}

impl TryInto<(f32, f32, f32)> for FieldValue {
    type Error = FieldValueError;

    fn try_into(self) -> Result<(f32, f32, f32), FieldValueError> {
        if let FieldValue::Vector3D(x) = self {
            Ok(x.into())
        } else {
            Err(FieldValueError::ConversionError(
                format!("{:?}", self),
                "(f32, f32, f32)".to_string(),
            ))
        }
    }
}

impl TryInto<(f32, f32, f32)> for &FieldValue {
    type Error = FieldValueError;

    fn try_into(self) -> Result<(f32, f32, f32), FieldValueError> {
        if let FieldValue::Vector3D(x) = self {
            Ok((*x).into())
        } else {
            Err(FieldValueError::ConversionError(
                format!("{:?}", self),
                "(f32, f32, f32)".to_string(),
            ))
        }
    }
}

impl TryInto<[f32; 4]> for FieldValue {
    type Error = FieldValueError;

    fn try_into(self) -> Result<[f32; 4], FieldValueError> {
        if let FieldValue::Vector4D(x) = self {
            Ok(x)
        } else {
            Err(FieldValueError::ConversionError(
                format!("{:?}", self),
                "[f32; 4]".to_string(),
            ))
        }
    }
}

impl TryInto<[f32; 4]> for &FieldValue {
    type Error = FieldValueError;

    fn try_into(self) -> Result<[f32; 4], FieldValueError> {
        if let FieldValue::Vector4D(x) = self {
            Ok(*x)
        } else {
            Err(FieldValueError::ConversionError(
                format!("{:?}", self),
                "[f32; 4]".to_string(),
            ))
        }
    }
}

impl TryInto<(f32, f32, f32, f32)> for FieldValue {
    type Error = FieldValueError;

    fn try_into(self) -> Result<(f32, f32, f32, f32), FieldValueError> {
        if let FieldValue::Vector4D(x) = self {
            Ok(x.into())
        } else {
            Err(FieldValueError::ConversionError(
                format!("{:?}", self),
                "(f32, f32, f32, f32)".to_string(),
            ))
        }
    }
}

impl TryInto<(f32, f32, f32, f32)> for &FieldValue {
    type Error = FieldValueError;

    fn try_into(self) -> Result<(f32, f32, f32, f32), FieldValueError> {
        if let FieldValue::Vector4D(x) = self {
            Ok((*x).into())
        } else {
            Err(FieldValueError::ConversionError(
                format!("{:?}", self),
                "(f32, f32, f32, f32)".to_string(),
            ))
        }
    }
}

impl TryInto<Vec<f32>> for FieldValue {
    type Error = FieldValueError;

    fn try_into(self) -> Result<Vec<f32>, FieldValueError> {
        match self {
            FieldValue::Vector2D(x) => Ok(x.to_vec()),
            FieldValue::Vector3D(x) => Ok(x.to_vec()),
            FieldValue::Vector4D(x) => Ok(x.to_vec()),
            _ => Err(FieldValueError::ConversionError(
                format!("{:?}", self),
                "Vec<f32>".to_string(),
            )),
        }
    }
}

impl TryInto<Vec<f32>> for &FieldValue {
    type Error = FieldValueError;

    fn try_into(self) -> Result<Vec<f32>, FieldValueError> {
        match self {
            FieldValue::Vector2D(x) => Ok(x.to_vec()),
            FieldValue::Vector3D(x) => Ok(x.to_vec()),
            FieldValue::Vector4D(x) => Ok(x.to_vec()),
            _ => Err(FieldValueError::ConversionError(
                format!("{:?}", self),
                "Vec<f32>".to_string(),
            )),
        }
    }
}

impl TryInto<f32> for FieldValue {
    type Error = FieldValueError;

    fn try_into(self) -> Result<f32, FieldValueError> {
        if let FieldValue::Float(x) = self {
            Ok(x)
        } else {
            Err(FieldValueError::ConversionError(
                format!("{:?}", self),
                "f32".to_string(),
            ))
        }
    }
}

impl TryInto<f32> for &FieldValue {
    type Error = FieldValueError;

    fn try_into(self) -> Result<f32, FieldValueError> {
        if let FieldValue::Float(x) = self {
            Ok(*x)
        } else {
            Err(FieldValueError::ConversionError(
                format!("{:?}", self),
                "f32".to_string(),
            ))
        }
    }
}

impl TryInto<bool> for FieldValue {
    type Error = FieldValueError;

    fn try_into(self) -> Result<bool, FieldValueError> {
        if let FieldValue::Boolean(x) = self {
            Ok(x)
        } else {
            Err(FieldValueError::ConversionError(
                format!("{:?}", self),
                "bool".to_string(),
            ))
        }
    }
}

impl TryInto<bool> for &FieldValue {
    type Error = FieldValueError;

    fn try_into(self) -> Result<bool, FieldValueError> {
        if let FieldValue::Boolean(x) = self {
            Ok(*x)
        } else {
            Err(FieldValueError::ConversionError(
                format!("{:?}", self),
                "bool".to_string(),
            ))
        }
    }
}

macro_rules! impl_try_into_for_integers {
    ($target:ty) => {
        impl TryInto<$target> for FieldValue {
            type Error = FieldValueError;

            fn try_into(self) -> Result<$target, FieldValueError> {
                match self {
                    // EntityFieldType::Boolean(x) => Ok((x == 1) as $target),
                    FieldValue::Signed8(x) => {
                        Ok(TryInto::<$target>::try_into(x).map_err(|_| {
                            FieldValueError::ConversionError(
                                format!("{:?}", x),
                                stringify!($target).to_string(),
                            )
                        })?)
                    }
                    FieldValue::Signed16(x) => {
                        Ok(TryInto::<$target>::try_into(x).map_err(|_| {
                            FieldValueError::ConversionError(
                                format!("{:?}", x),
                                stringify!($target).to_string(),
                            )
                        })?)
                    }
                    FieldValue::Signed32(x) => {
                        Ok(TryInto::<$target>::try_into(x).map_err(|_| {
                            FieldValueError::ConversionError(
                                format!("{:?}", x),
                                stringify!($target).to_string(),
                            )
                        })?)
                    }
                    FieldValue::Signed64(x) => {
                        Ok(TryInto::<$target>::try_into(x).map_err(|_| {
                            FieldValueError::ConversionError(
                                format!("{:?}", x),
                                stringify!($target).to_string(),
                            )
                        })?)
                    }
                    FieldValue::Unsigned8(x) => {
                        Ok(TryInto::<$target>::try_into(x).map_err(|_| {
                            FieldValueError::ConversionError(
                                format!("{:?}", x),
                                stringify!($target).to_string(),
                            )
                        })?)
                    }
                    FieldValue::Unsigned16(x) => {
                        Ok(TryInto::<$target>::try_into(x).map_err(|_| {
                            FieldValueError::ConversionError(
                                format!("{:?}", x),
                                stringify!($target).to_string(),
                            )
                        })?)
                    }
                    FieldValue::Unsigned32(x) => {
                        Ok(TryInto::<$target>::try_into(x).map_err(|_| {
                            FieldValueError::ConversionError(
                                format!("{:?}", x),
                                stringify!($target).to_string(),
                            )
                        })?)
                    }
                    FieldValue::Unsigned64(x) => {
                        Ok(TryInto::<$target>::try_into(x).map_err(|_| {
                            FieldValueError::ConversionError(
                                format!("{:?}", x),
                                stringify!($target).to_string(),
                            )
                        })?)
                    }
                    FieldValue::Float(x) => Ok(x as $target),
                    _ => Err(FieldValueError::ConversionError(
                        format!("{:?}", self),
                        stringify!($target).to_string(),
                    )),
                }
            }
        }

        impl TryInto<$target> for &FieldValue {
            type Error = FieldValueError;

            fn try_into(self) -> Result<$target, FieldValueError> {
                match self {
                    // EntityFieldType::Boolean(x) => Ok(x == 1 as $target),
                    FieldValue::Signed8(x) => {
                        Ok(TryInto::<$target>::try_into(*x).map_err(|_| {
                            FieldValueError::ConversionError(
                                format!("{:?}", x),
                                stringify!($target).to_string(),
                            )
                        })?)
                    }
                    FieldValue::Signed16(x) => {
                        Ok(TryInto::<$target>::try_into(*x).map_err(|_| {
                            FieldValueError::ConversionError(
                                format!("{:?}", x),
                                stringify!($target).to_string(),
                            )
                        })?)
                    }
                    FieldValue::Signed32(x) => {
                        Ok(TryInto::<$target>::try_into(*x).map_err(|_| {
                            FieldValueError::ConversionError(
                                format!("{:?}", x),
                                stringify!($target).to_string(),
                            )
                        })?)
                    }
                    FieldValue::Signed64(x) => {
                        Ok(TryInto::<$target>::try_into(*x).map_err(|_| {
                            FieldValueError::ConversionError(
                                format!("{:?}", x),
                                stringify!($target).to_string(),
                            )
                        })?)
                    }
                    FieldValue::Unsigned8(x) => {
                        Ok(TryInto::<$target>::try_into(*x).map_err(|_| {
                            FieldValueError::ConversionError(
                                format!("{:?}", x),
                                stringify!($target).to_string(),
                            )
                        })?)
                    }
                    FieldValue::Unsigned16(x) => {
                        Ok(TryInto::<$target>::try_into(*x).map_err(|_| {
                            FieldValueError::ConversionError(
                                format!("{:?}", x),
                                stringify!($target).to_string(),
                            )
                        })?)
                    }
                    FieldValue::Unsigned32(x) => {
                        Ok(TryInto::<$target>::try_into(*x).map_err(|_| {
                            FieldValueError::ConversionError(
                                format!("{:?}", x),
                                stringify!($target).to_string(),
                            )
                        })?)
                    }
                    FieldValue::Unsigned64(x) => {
                        Ok(TryInto::<$target>::try_into(*x).map_err(|_| {
                            FieldValueError::ConversionError(
                                format!("{:?}", x),
                                stringify!($target).to_string(),
                            )
                        })?)
                    }
                    FieldValue::Float(x) => Ok(*x as $target),
                    _ => Err(FieldValueError::ConversionError(
                        format!("{:?}", self),
                        stringify!($target).to_string(),
                    )),
                }
            }
        }
    };
}

impl_try_into_for_integers!(i8);
impl_try_into_for_integers!(i16);
impl_try_into_for_integers!(i32);
impl_try_into_for_integers!(i64);
impl_try_into_for_integers!(i128);
impl_try_into_for_integers!(u8);
impl_try_into_for_integers!(u16);
impl_try_into_for_integers!(u32);
impl_try_into_for_integers!(u64);
impl_try_into_for_integers!(u128);
impl_try_into_for_integers!(usize);
impl_try_into_for_integers!(isize);

#[allow(dead_code)]
impl FieldValue {
    /// Return the inner string. Panics if this is not a `FieldValue::String`.
    #[inline]
    pub fn string(&self) -> String {
        if let FieldValue::String(s) = self {
            s.to_string()
        } else {
            panic!("Tried to read as String, Found {:?}", self);
        }
    }

    /// Return the inner boolean. Panics if this is not a `FieldValue::Boolean`.
    #[inline]
    pub fn bool(&self) -> bool {
        if let FieldValue::Boolean(b) = self {
            *b
        } else {
            panic!("Tried to read as Boolean, Found {:?}", self);
        }
    }

    /// Return the inner f32. Panics if this is not a `FieldValue::Float`.
    #[inline]
    pub fn f32(&self) -> f32 {
        if let FieldValue::Float(f) = self {
            *f
        } else {
            panic!("Tried to read as Float, Found {:?}", self);
        }
    }

    /// Return a reference to a 2D vector ([f32; 2]). Panics if the value is not
    /// `Vector2D`.
    #[inline]
    pub fn vec2(&self) -> &[f32; 2] {
        if let FieldValue::Vector2D(v) = self {
            v
        } else {
            panic!("Tried to read as Vector2D, Found {:?}", self);
        }
    }

    /// Return a reference to a 3D vector ([f32; 3]). Panics if the value is not
    /// `Vector3D`.
    #[inline]
    pub fn vec3(&self) -> &[f32; 3] {
        if let FieldValue::Vector3D(v) = self {
            v
        } else {
            panic!("Tried to read as Vector3D, Found {:?}", self);
        }
    }

    /// Return a reference to a 4D vector ([f32; 4]). Panics if the value is not
    /// `Vector4D`.
    #[inline]
    pub fn vec4(&self) -> &[f32; 4] {
        if let FieldValue::Vector4D(v) = self {
            v
        } else {
            panic!("Tried to read as Vector4D, Found {:?}", self);
        }
    }

    /// Read as signed 8-bit integer. Panics if value is not `Signed8`.
    #[inline]
    pub fn i8(&self) -> i8 {
        match self {
            FieldValue::Signed8(x) => *x,
            _ => panic!("Tried to read as i8, Found {:?}", self),
        }
    }

    /// Read as signed 16-bit integer. Panics if value is not `Signed16`.
    #[inline]
    pub fn i16(&self) -> i16 {
        match self {
            FieldValue::Signed16(x) => *x,
            _ => panic!("Tried to read as i16, Found {:?}", self),
        }
    }

    /// Read as signed 32-bit integer. Panics if value is not `Signed32`.
    #[inline]
    pub fn i32(&self) -> i32 {
        match self {
            FieldValue::Signed32(x) => *x,
            _ => panic!("Tried to read as i32, Found {:?}", self),
        }
    }

    /// Read as signed 64-bit integer. Panics if value is not `Signed64`.
    #[inline]
    pub fn i64(&self) -> i64 {
        match self {
            FieldValue::Signed64(x) => *x,
            _ => panic!("Tried to read as i64, Found {:?}", self),
        }
    }

    /// Read as unsigned 8-bit integer. Panics if value is not `Unsigned8`.
    #[inline]
    pub fn u8(&self) -> u8 {
        match self {
            FieldValue::Unsigned8(x) => *x,
            _ => panic!("Tried to read as u8, Found {:?}", self),
        }
    }

    /// Read as unsigned 16-bit integer. Panics if value is not `Unsigned16`.
    #[inline]
    pub fn u16(&self) -> u16 {
        match self {
            FieldValue::Unsigned16(x) => *x,
            _ => panic!("Tried to read as u16, Found {:?}", self),
        }
    }

    /// Read as unsigned 32-bit integer. Panics if value is not `Unsigned32`.
    #[inline]
    pub fn u32(&self) -> u32 {
        match self {
            FieldValue::Unsigned32(x) => *x,
            _ => panic!("Tried to read as u32, Found {:?}", self),
        }
    }

    /// Read as unsigned 64-bit integer. Panics if value is not `Unsigned64`.
    #[inline]
    pub fn u64(&self) -> u64 {
        match self {
            FieldValue::Unsigned64(x) => *x,
            _ => panic!("Tried to read as u64, Found {:?}", self),
        }
    }

    /// Read as `usize`. Accepts `Unsigned32` or `Unsigned64` and casts to
    /// `usize`. Panics for other variants.
    #[inline]
    pub fn usize(&self) -> usize {
        match self {
            FieldValue::Unsigned32(x) => *x as usize,
            FieldValue::Unsigned64(x) => *x as usize,
            _ => panic!("Tried to read as usize, Found {:?}", self),
        }
    }
}
