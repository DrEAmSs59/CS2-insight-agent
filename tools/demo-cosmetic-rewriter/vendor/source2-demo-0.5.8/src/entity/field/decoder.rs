use crate::entity::field::{FieldEncoder, FieldProperties, FieldType, FieldValue};
use crate::reader::{BitsReader, SliceReader};
use crate::writer::{BitsWriter, BitstreamWriter};
use std::convert::TryInto;
use std::io;

pub(crate) trait Decode {
    fn decode(&self, reader: &mut SliceReader) -> FieldValue;
}

pub(crate) trait Skip {
    fn skip(&self, reader: &mut SliceReader);
}

pub(crate) trait Encode<T: ?Sized = FieldValue> {
    fn encode(&self, writer: &mut BitstreamWriter<'_>, value: &T) -> io::Result<()>;
}

pub(crate) enum FieldDecoder {
    Boolean,
    String,
    BinaryBlock,
    Signed8,
    Signed16,
    Signed32,
    Unsigned8,
    Unsigned16,
    Unsigned32,

    Vector(VectorDecoder),
    Unsigned64(Unsigned64Decoder),
    Float32(Float32Decoder),
    QuantizedFloat(QuantizedFloatDecoder),
    QAngle(QAngleDecoder),

    CCSGameModeRules,
}

impl FieldDecoder {
    #[inline]
    pub(crate) fn from_field(field_type: &FieldType, properties: FieldProperties) -> Self {
        match field_type.base.as_ref() {
            "bool" | "CBodyComponent" | "CPhysicsComponent" | "CRenderComponent" => {
                FieldDecoder::Boolean
            }

            "char" | "CUtlString" | "CUtlSymbolLarge" | "CGlobalSymbol" => FieldDecoder::String,

            "CUtlBinaryBlock" => FieldDecoder::BinaryBlock,

            "Vector" | "VectorWS" => FieldDecoder::Vector(VectorDecoder {
                properties,
                dimensions: 3,
            }),
            "Vector2D" => FieldDecoder::Vector(VectorDecoder {
                properties,
                dimensions: 2,
            }),
            "Vector4D" | "Quaternion" => FieldDecoder::Vector(VectorDecoder {
                properties,
                dimensions: 4,
            }),

            "QAngle" => FieldDecoder::QAngle(QAngleDecoder { properties }),

            "CNetworkedQuantizedFloat" => {
                FieldDecoder::QuantizedFloat(QuantizedFloatDecoder::new(&properties))
            }
            "float32" | "GameTime_t" => FieldDecoder::Float32(Float32Decoder { properties }),

            "int8" => FieldDecoder::Signed8,
            "int16" => FieldDecoder::Signed16,
            "int32" => FieldDecoder::Signed32,

            #[cfg(feature = "dota")]
            "HeroID_t" => FieldDecoder::Signed32,

            "uint8" | "BloodType" => FieldDecoder::Unsigned8,
            "uint16" => FieldDecoder::Unsigned16,
            "uint64" | "CStrongHandle" | "HeroFacetKey_t" | "ResourceId_t" => {
                FieldDecoder::Unsigned64(Unsigned64Decoder { properties })
            }

            _ => FieldDecoder::Unsigned32,
        }
    }
}

impl Decode for FieldDecoder {
    #[inline]
    fn decode(&self, reader: &mut SliceReader) -> FieldValue {
        match self {
            FieldDecoder::Boolean => FieldValue::Boolean({
                reader.refill();
                reader.read_bool()
            }),
            FieldDecoder::String => FieldValue::String(reader.read_cstring()),
            FieldDecoder::BinaryBlock => FieldValue::String({
                let n = reader.read_var_u32();
                let bytes = reader.read_bytes(n);
                String::from_utf8_lossy(&bytes).into_owned()
            }),

            FieldDecoder::Signed8 => FieldValue::Signed8(reader.read_var_i32() as i8),
            FieldDecoder::Signed16 => FieldValue::Signed16(reader.read_var_i32() as i16),
            FieldDecoder::Signed32 => FieldValue::Signed32(reader.read_var_i32()),

            FieldDecoder::Unsigned8 => FieldValue::Unsigned8(reader.read_var_u32() as u8),
            FieldDecoder::Unsigned16 => FieldValue::Unsigned16(reader.read_var_u32() as u16),
            FieldDecoder::Unsigned32 => FieldValue::Unsigned32(reader.read_var_u32()),

            FieldDecoder::Vector(decoder) => decoder.decode(reader),
            FieldDecoder::Unsigned64(decoder) => decoder.decode(reader),
            FieldDecoder::Float32(decoder) => decoder.decode(reader),
            FieldDecoder::QuantizedFloat(decoder) => decoder.decode(reader),
            FieldDecoder::QAngle(decoder) => decoder.decode(reader),

            FieldDecoder::CCSGameModeRules => FieldValue::Boolean({
                reader.refill();
                let x = reader.read_bool();
                reader.read_ubit_var();
                x
            }),
        }
    }
}

impl Skip for FieldDecoder {
    #[inline]
    fn skip(&self, reader: &mut SliceReader) {
        match self {
            FieldDecoder::Boolean => {
                reader.refill();
                reader.skip_bits(1);
            }
            FieldDecoder::String => reader.skip_cstring(),
            FieldDecoder::BinaryBlock => {
                let n = reader.read_var_u32();
                reader.skip_bytes(n);
            }

            FieldDecoder::Signed8 | FieldDecoder::Signed16 | FieldDecoder::Signed32 => {
                reader.read_var_i32();
            }
            FieldDecoder::Unsigned8 | FieldDecoder::Unsigned16 | FieldDecoder::Unsigned32 => {
                reader.read_var_u32();
            }

            FieldDecoder::Unsigned64(decoder) => decoder.skip(reader),
            FieldDecoder::Vector(decoder) => decoder.skip(reader),
            FieldDecoder::Float32(decoder) => decoder.skip(reader),
            FieldDecoder::QuantizedFloat(decoder) => decoder.skip(reader),
            FieldDecoder::QAngle(decoder) => decoder.skip(reader),

            FieldDecoder::CCSGameModeRules => {
                reader.refill();
                reader.skip_bits(1);
                reader.read_ubit_var();
            }
        }
    }
}

impl Encode for FieldDecoder {
    #[inline]
    fn encode(&self, writer: &mut BitstreamWriter<'_>, value: &FieldValue) -> io::Result<()> {
        match self {
            FieldDecoder::Boolean => writer.write_bit(value.bool()),
            FieldDecoder::String => writer.write_cstring(&value.string()),
            FieldDecoder::BinaryBlock => {
                let bytes = value.string();
                writer.write_var_u32(bytes.len() as u32)?;
                writer.write_bytes(bytes.as_bytes())
            }
            FieldDecoder::Signed8 => writer.write_var_i32(value.i8() as i32),
            FieldDecoder::Signed16 => writer.write_var_i32(value.i16() as i32),
            FieldDecoder::Signed32 => writer.write_var_i32(value.i32()),
            FieldDecoder::Unsigned8 => writer.write_var_u32(value.u8() as u32),
            FieldDecoder::Unsigned16 => writer.write_var_u32(value.u16() as u32),
            FieldDecoder::Unsigned32 => writer.write_var_u32(value.u32()),
            FieldDecoder::Unsigned64(decoder) => decoder.encode(writer, value),
            FieldDecoder::Vector(decoder) => decoder.encode(writer, value),
            FieldDecoder::Float32(decoder) => decoder.encode(writer, value),
            FieldDecoder::QuantizedFloat(decoder) => decoder.encode(writer, &value.f32()),
            FieldDecoder::QAngle(decoder) => decoder.encode(writer, value),
            FieldDecoder::CCSGameModeRules => {
                writer.write_bit(value.bool())?;
                writer.write_var_u32(0)?;
                Ok(())
            }
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct VectorDecoder {
    properties: FieldProperties,
    pub(crate) dimensions: u8,
}

impl VectorDecoder {
    pub(crate) fn dimensions(&self) -> u8 {
        self.dimensions
    }
}

impl Decode for VectorDecoder {
    fn decode(&self, reader: &mut SliceReader) -> FieldValue {
        let decoder = Float32Decoder {
            properties: self.properties,
        };

        match self.dimensions {
            2 => FieldValue::Vector2D([decoder.decode(reader).f32(), decoder.decode(reader).f32()]),
            3 => {
                if self.properties.encoder == Some(FieldEncoder::Normal) {
                    FieldValue::Vector3D(reader.read_normal_vec3())
                } else {
                    FieldValue::Vector3D([
                        decoder.decode(reader).f32(),
                        decoder.decode(reader).f32(),
                        decoder.decode(reader).f32(),
                    ])
                }
            }
            4 => FieldValue::Vector4D([
                decoder.decode(reader).f32(),
                decoder.decode(reader).f32(),
                decoder.decode(reader).f32(),
                decoder.decode(reader).f32(),
            ]),
            _ => unreachable!("Invalid vector dimension: {}", self.dimensions),
        }
    }
}

impl Skip for VectorDecoder {
    fn skip(&self, reader: &mut SliceReader) {
        let decoder = Float32Decoder {
            properties: self.properties,
        };

        match self.dimensions {
            2 => {
                decoder.skip(reader);
                decoder.skip(reader);
            }
            3 => {
                if self.properties.encoder == Some(FieldEncoder::Normal) {
                    reader.read_normal_vec3();
                } else {
                    decoder.skip(reader);
                    decoder.skip(reader);
                    decoder.skip(reader);
                }
            }
            4 => {
                decoder.skip(reader);
                decoder.skip(reader);
                decoder.skip(reader);
                decoder.skip(reader);
            }
            _ => unreachable!("Invalid vector dimension: {}", self.dimensions),
        }
    }
}

impl Encode for VectorDecoder {
    fn encode(&self, writer: &mut BitstreamWriter<'_>, value: &FieldValue) -> io::Result<()> {
        let decoder = Float32Decoder {
            properties: self.properties,
        };

        match self.dimensions {
            2 => {
                let v: [f32; 2] = value
                    .try_into()
                    .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "expected vec2"))?;
                decoder.encode(writer, &FieldValue::Float(v[0]))?;
                decoder.encode(writer, &FieldValue::Float(v[1]))
            }
            3 => {
                if self.properties.encoder == Some(FieldEncoder::Normal) {
                    let v: [f32; 3] = value.try_into().map_err(|_| {
                        io::Error::new(io::ErrorKind::InvalidInput, "expected vec3")
                    })?;
                    writer.write_normal_vec3(v)
                } else {
                    let v: [f32; 3] = value.try_into().map_err(|_| {
                        io::Error::new(io::ErrorKind::InvalidInput, "expected vec3")
                    })?;
                    decoder.encode(writer, &FieldValue::Float(v[0]))?;
                    decoder.encode(writer, &FieldValue::Float(v[1]))?;
                    decoder.encode(writer, &FieldValue::Float(v[2]))
                }
            }
            4 => {
                let v: [f32; 4] = value
                    .try_into()
                    .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "expected vec4"))?;
                decoder.encode(writer, &FieldValue::Float(v[0]))?;
                decoder.encode(writer, &FieldValue::Float(v[1]))?;
                decoder.encode(writer, &FieldValue::Float(v[2]))?;
                decoder.encode(writer, &FieldValue::Float(v[3]))
            }
            _ => unreachable!("Invalid vector dimension: {}", self.dimensions),
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Unsigned64Decoder {
    pub(crate) properties: FieldProperties,
}

impl Decode for Unsigned64Decoder {
    fn decode(&self, reader: &mut SliceReader) -> FieldValue {
        if self.properties.encoder == Some(FieldEncoder::Fixed64) {
            FieldValue::Unsigned64(reader.read_u64_le())
        } else {
            FieldValue::Unsigned64(reader.read_var_u64())
        }
    }
}

impl Skip for Unsigned64Decoder {
    fn skip(&self, reader: &mut SliceReader) {
        if self.properties.encoder == Some(FieldEncoder::Fixed64) {
            reader.skip_bits(64);
        } else {
            reader.read_var_u64();
        }
    }
}

impl Encode for Unsigned64Decoder {
    fn encode(&self, writer: &mut BitstreamWriter<'_>, value: &FieldValue) -> io::Result<()> {
        let v = value.u64();
        if self.properties.encoder == Some(FieldEncoder::Fixed64) {
            writer.write_u64_le(v)
        } else {
            writer.write_var_u64(v)
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Float32Decoder {
    properties: FieldProperties,
}

impl Decode for Float32Decoder {
    fn decode(&self, reader: &mut SliceReader) -> FieldValue {
        match self.properties.encoder {
            Some(FieldEncoder::Coord) => FieldValue::Float(reader.read_coordinate()),
            Some(FieldEncoder::SimTime) => FieldValue::Float(reader.read_var_u32() as f32 / 30.0),
            Some(FieldEncoder::RuneTime) => FieldValue::Float(f32::from_bits(
                reader.read_bits(self.properties.bit_count as u32),
            )),
            _ => {
                if self.properties.bit_count == 32 {
                    FieldValue::Float(reader.read_f32())
                } else {
                    QuantizedFloatDecoder::new(&self.properties).decode(reader)
                }
            }
        }
    }
}

impl Skip for Float32Decoder {
    fn skip(&self, reader: &mut SliceReader) {
        match self.properties.encoder {
            Some(FieldEncoder::Coord) => {
                reader.read_coordinate();
            }
            Some(FieldEncoder::SimTime) => {
                reader.read_var_u32();
            }
            Some(FieldEncoder::RuneTime) => {
                reader.skip_bits(self.properties.bit_count as u32);
            }
            _ => {
                if self.properties.bit_count == 32 {
                    reader.skip_bits(32);
                } else {
                    QuantizedFloatDecoder::new(&self.properties).skip(reader);
                }
            }
        }
    }
}

impl Encode for Float32Decoder {
    fn encode(&self, writer: &mut BitstreamWriter<'_>, value: &FieldValue) -> io::Result<()> {
        let v = value.f32();
        match self.properties.encoder {
            Some(FieldEncoder::Coord) => writer.write_coordinate(v),
            Some(FieldEncoder::SimTime) => writer.write_var_u32((v * 30.0).round() as u32),
            Some(FieldEncoder::RuneTime) => {
                writer.write_bits(self.properties.bit_count as u32, v.to_bits() as u64)
            }
            _ => {
                if self.properties.bit_count == 32 {
                    writer.write_f32(v)
                } else {
                    QuantizedFloatDecoder::new(&self.properties).encode(writer, &v)
                }
            }
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct QAngleDecoder {
    properties: FieldProperties,
}

impl Decode for QAngleDecoder {
    fn decode(&self, reader: &mut SliceReader) -> FieldValue {
        reader.refill();

        if self.properties.encoder == Some(FieldEncoder::QAnglePitchYaw) {
            return FieldValue::Vector3D([
                reader.read_angle(self.properties.bit_count as u32),
                reader.read_angle(self.properties.bit_count as u32),
                0.0,
            ]);
        }

        if self.properties.encoder == Some(FieldEncoder::QAnglePrecise) {
            let mut v = [0f32; 3];
            let x = reader.read_bool();
            let y = reader.read_bool();
            let z = reader.read_bool();
            if x {
                v[0] = reader.read_angle(20);
            }
            if y {
                v[1] = reader.read_angle(20);
            }
            if z {
                v[2] = reader.read_angle(20);
            }
            return FieldValue::Vector3D(v);
        }

        if self.properties.bit_count != 0 && self.properties.bit_count != 32 {
            let n = self.properties.bit_count as u32;
            return FieldValue::Vector3D([
                reader.read_angle(n),
                reader.read_angle(n),
                reader.read_angle(n),
            ]);
        }

        if self.properties.bit_count == 32 {
            return FieldValue::Vector3D([reader.read_f32(), reader.read_f32(), reader.read_f32()]);
        }

        let mut v = [0f32; 3];
        let x = reader.read_bool();
        let y = reader.read_bool();
        let z = reader.read_bool();
        if x {
            v[0] = reader.read_coordinate();
        }
        if y {
            v[1] = reader.read_coordinate();
        }
        if z {
            v[2] = reader.read_coordinate();
        }

        FieldValue::Vector3D(v)
    }
}

impl Skip for QAngleDecoder {
    fn skip(&self, reader: &mut SliceReader) {
        reader.refill();

        if self.properties.encoder == Some(FieldEncoder::QAnglePitchYaw) {
            reader.skip_bits((self.properties.bit_count * 2) as u32);
            return;
        }

        if self.properties.encoder == Some(FieldEncoder::QAnglePrecise) {
            let x = reader.read_bool();
            let y = reader.read_bool();
            let z = reader.read_bool();
            if x {
                reader.skip_bits(20);
            }
            if y {
                reader.skip_bits(20);
            }
            if z {
                reader.skip_bits(20);
            }
            return;
        }

        if self.properties.bit_count != 0 && self.properties.bit_count != 32 {
            reader.skip_bits((self.properties.bit_count * 3) as u32);
            return;
        }

        if self.properties.bit_count == 32 {
            reader.skip_bits(96);
            return;
        }

        let x = reader.read_bool();
        let y = reader.read_bool();
        let z = reader.read_bool();
        if x {
            reader.read_coordinate();
        }
        if y {
            reader.read_coordinate();
        }
        if z {
            reader.read_coordinate();
        }
    }
}

impl Encode for QAngleDecoder {
    fn encode(&self, writer: &mut BitstreamWriter<'_>, value: &FieldValue) -> io::Result<()> {
        let v: [f32; 3] = value
            .try_into()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "expected vec3"))?;
        if self.properties.encoder == Some(FieldEncoder::QAnglePitchYaw) {
            writer.write_angle(v[0], self.properties.bit_count as u32)?;
            writer.write_angle(v[1], self.properties.bit_count as u32)?;
            return Ok(());
        }

        if self.properties.encoder == Some(FieldEncoder::QAnglePrecise) {
            writer.write_bit(v[0] != 0.0)?;
            writer.write_bit(v[1] != 0.0)?;
            writer.write_bit(v[2] != 0.0)?;
            if v[0] != 0.0 {
                writer.write_angle(v[0], 20)?;
            }
            if v[1] != 0.0 {
                writer.write_angle(v[1], 20)?;
            }
            if v[2] != 0.0 {
                writer.write_angle(v[2], 20)?;
            }
            return Ok(());
        }

        if self.properties.bit_count != 0 && self.properties.bit_count != 32 {
            let n = self.properties.bit_count as u32;
            writer.write_angle(v[0], n)?;
            writer.write_angle(v[1], n)?;
            writer.write_angle(v[2], n)?;
            return Ok(());
        }

        if self.properties.bit_count == 32 {
            writer.write_f32(v[0])?;
            writer.write_f32(v[1])?;
            return writer.write_f32(v[2]);
        }

        writer.write_bit(v[0] != 0.0)?;
        writer.write_bit(v[1] != 0.0)?;
        writer.write_bit(v[2] != 0.0)?;
        if v[0] != 0.0 {
            writer.write_coordinate(v[0])?;
        }
        if v[1] != 0.0 {
            writer.write_coordinate(v[1])?;
        }
        if v[2] != 0.0 {
            writer.write_coordinate(v[2])?;
        }
        Ok(())
    }
}

enum QuantizedFloatFlags {
    RoundDown = 1 << 0,
    RoundUp = 1 << 1,
    EncodeZero = 1 << 2,
    EncodeInteger = 1 << 3,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct QuantizedFloatDecoder {
    bit_count: u32,
    low: f32,
    high: f32,
    high_low_mul: f32,
    dec_mul: f32,
    offset: f32,
    flags: u32,
}

impl QuantizedFloatDecoder {
    pub(crate) fn new(field_properties: &FieldProperties) -> Self {
        let mut decoder = QuantizedFloatDecoder {
            bit_count: field_properties.bit_count as u32,
            offset: 0.0,
            low: field_properties.low_value,
            high: field_properties.high_value,
            flags: field_properties.encoder_flags as u32,
            high_low_mul: 0.0,
            dec_mul: 0.0,
        };

        decoder.validate_flags();

        let mut steps = 1_u32.wrapping_shl(decoder.bit_count);

        if decoder.flags & (QuantizedFloatFlags::RoundDown as u32) != 0 {
            decoder.offset = (decoder.high - decoder.low) / (steps as f32);
            decoder.high -= decoder.offset;
        } else if decoder.flags & (QuantizedFloatFlags::RoundUp as u32) != 0 {
            decoder.offset = (decoder.high - decoder.low) / (steps as f32);
            decoder.low += decoder.offset;
        }

        if decoder.flags & (QuantizedFloatFlags::EncodeInteger as u32) != 0 {
            let delta = 1.0f32.max(decoder.high + decoder.low).log2().ceil() as u32;
            let range2 = (1 << delta) as u32;
            let mut bc = decoder.bit_count;

            while (1 << bc) <= range2 {
                bc += 1;
            }

            if bc > decoder.bit_count {
                decoder.bit_count = bc;
                steps = 1 << decoder.bit_count;
            }

            decoder.offset = (range2 as f32) / (steps as f32);
            decoder.high = decoder.low + range2 as f32 - decoder.offset
        }

        decoder.assign_multipliers(steps);

        if decoder.flags & (QuantizedFloatFlags::RoundDown as u32) != 0
            && decoder.quantize(decoder.low) == decoder.low
        {
            decoder.flags &= !(QuantizedFloatFlags::RoundDown as u32)
        }

        if decoder.flags & (QuantizedFloatFlags::RoundUp as u32) != 0
            && decoder.quantize(decoder.high) == decoder.high
        {
            decoder.flags &= !(QuantizedFloatFlags::RoundUp as u32)
        }

        if decoder.flags & (QuantizedFloatFlags::EncodeZero as u32) != 0
            && decoder.quantize(0.0) == 0.0
        {
            decoder.flags &= !(QuantizedFloatFlags::EncodeZero as u32)
        }

        decoder
    }

    fn validate_flags(&mut self) {
        if self.flags == 0 {
            return;
        }

        if self.low == 0.0 && (self.flags & QuantizedFloatFlags::RoundDown as u32) != 0
            || self.high == 0.0 && (self.flags & QuantizedFloatFlags::RoundUp as u32) != 0
        {
            self.flags &= !(QuantizedFloatFlags::EncodeZero as u32);
        }

        if self.low == 0.0 && (self.flags & QuantizedFloatFlags::EncodeZero as u32) != 0 {
            self.flags |= QuantizedFloatFlags::RoundUp as u32;
            self.flags &= !(QuantizedFloatFlags::EncodeZero as u32);
        }

        if self.high == 0.0 && (self.flags & QuantizedFloatFlags::EncodeZero as u32) != 0 {
            self.flags |= QuantizedFloatFlags::RoundDown as u32;
            self.flags &= !(QuantizedFloatFlags::EncodeZero as u32);
        }

        if self.low > 0.0 || self.high < 0.0 {
            self.flags &= !(QuantizedFloatFlags::EncodeZero as u32);
        }

        if self.flags & (QuantizedFloatFlags::EncodeInteger as u32) != 0 {
            self.flags &= !(QuantizedFloatFlags::RoundUp as u32
                | QuantizedFloatFlags::RoundDown as u32
                | QuantizedFloatFlags::EncodeZero as u32);
        }

        debug_assert!(
            self.flags
                & (QuantizedFloatFlags::RoundDown as u32 | QuantizedFloatFlags::RoundUp as u32)
                != (QuantizedFloatFlags::RoundDown as u32 | QuantizedFloatFlags::RoundUp as u32),
            "Roundup / Rounddown are mutually exclusive"
        )
    }

    fn assign_multipliers(&mut self, steps: u32) {
        let range = self.high - self.low;

        let high = if self.bit_count == 32 {
            0xFFFFFFFEu32
        } else {
            (1 << self.bit_count) - 1
        };

        let mut high_mul = if range.abs() as f64 <= 0.0 {
            high as f32
        } else {
            (high as f32) / range
        };

        if high_mul * range > (high as f32) || (high_mul * range) as f64 > (high as f64) {
            for mult in [0.9999, 0.99, 0.9, 0.8, 0.7] {
                high_mul = (high as f32) / range * mult;
                if high_mul * range <= high as f32 && (high_mul * range) as f64 <= high as f64 {
                    break;
                }
            }
        }

        self.high_low_mul = high_mul;

        self.dec_mul = 1.0 / ((steps - 1) as f32);

        debug_assert!(
            self.high_low_mul != 0.0,
            "Error computing high / low multiplier"
        )
    }

    pub(crate) fn quantize(&self, v: f32) -> f32 {
        if v < self.low {
            debug_assert!(
                self.flags & QuantizedFloatFlags::RoundUp as u32 != 0,
                "Field tried to quantize an out of range value"
            );
            return self.low;
        }

        if v > self.high {
            debug_assert!(
                self.flags & QuantizedFloatFlags::RoundDown as u32 != 0,
                "Field tried to quantize an out of range value"
            );
            return self.high;
        }

        let i = ((v - self.low) * self.high_low_mul) as u32;

        self.low + (self.high - self.low) * i as f32 * self.dec_mul
    }

    fn decode_float(&self, reader: &mut SliceReader) -> f32 {
        reader.refill();

        if self.bit_count == 32 {
            return f32::from_bits(reader.read_bits_unchecked(32));
        }

        if self.flags & (QuantizedFloatFlags::RoundDown as u32) != 0 && reader.read_bool() {
            return self.low;
        }

        if self.flags & (QuantizedFloatFlags::RoundUp as u32) != 0 && reader.read_bool() {
            return self.high;
        }

        if self.flags & (QuantizedFloatFlags::EncodeZero as u32) != 0 && reader.read_bool() {
            return 0.0;
        }

        self.low
            + (self.high - self.low)
                * (reader.read_bits_unchecked(self.bit_count) as f32)
                * self.dec_mul
    }
}

impl Encode<f32> for QuantizedFloatDecoder {
    fn encode(&self, writer: &mut BitstreamWriter<'_>, value: &f32) -> io::Result<()> {
        let value = *value;
        if self.bit_count == 32 {
            return writer.write_f32(value);
        }

        if self.flags & (QuantizedFloatFlags::RoundDown as u32) != 0 && value == self.low {
            writer.write_bit(true)?;
            return Ok(());
        }
        if self.flags & (QuantizedFloatFlags::RoundUp as u32) != 0 && value == self.high {
            writer.write_bit(true)?;
            return Ok(());
        }
        if self.flags & (QuantizedFloatFlags::EncodeZero as u32) != 0 && value == 0.0 {
            writer.write_bit(true)?;
            return Ok(());
        }

        if self.flags & (QuantizedFloatFlags::RoundDown as u32) != 0 {
            writer.write_bit(false)?;
        }
        if self.flags & (QuantizedFloatFlags::RoundUp as u32) != 0 {
            writer.write_bit(false)?;
        }
        if self.flags & (QuantizedFloatFlags::EncodeZero as u32) != 0 {
            writer.write_bit(false)?;
        }

        let q = self.quantize(value);
        let i = ((q - self.low) * self.high_low_mul) as u32;
        writer.write_bits(self.bit_count, i as u64)
    }
}

impl Decode for QuantizedFloatDecoder {
    fn decode(&self, reader: &mut SliceReader) -> FieldValue {
        FieldValue::Float(self.decode_float(reader))
    }
}

impl Skip for QuantizedFloatDecoder {
    fn skip(&self, reader: &mut SliceReader) {
        reader.refill();

        if self.bit_count == 32 {
            reader.skip_bits(32);
            return;
        }

        if self.flags & (QuantizedFloatFlags::RoundDown as u32) != 0 && reader.read_bool() {
            return;
        }

        if self.flags & (QuantizedFloatFlags::RoundUp as u32) != 0 && reader.read_bool() {
            return;
        }

        if self.flags & (QuantizedFloatFlags::EncodeZero as u32) != 0 && reader.read_bool() {
            return;
        }

        reader.skip_bits(self.bit_count);
    }
}
