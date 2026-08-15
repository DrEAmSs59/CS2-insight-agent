use super::read_bits::Bitreader;
use super::read_bits::DemoParserError;
use crate::first_pass::parser_settings::needs_velocity;
use crate::first_pass::parser_settings::FirstPassParser;
use crate::first_pass::prop_controller::FLASHBANG_AMMO_ID;
use crate::first_pass::prop_controller::GRENADE_AMMO_ID;
use crate::first_pass::prop_controller::PropController;
use crate::first_pass::prop_controller::FLATTENED_VEC_MAX_LEN;
use crate::first_pass::prop_controller::GLOVE_PAINT_ID;
use crate::first_pass::prop_controller::ITEM_PURCHASE_COST;
use crate::first_pass::prop_controller::ITEM_PURCHASE_COUNT;
use crate::first_pass::prop_controller::ITEM_PURCHASE_DEF_IDX;
use crate::first_pass::prop_controller::ITEM_PURCHASE_HANDLE;
use crate::first_pass::prop_controller::ITEM_PURCHASE_NEW_DEF_IDX;
use crate::first_pass::prop_controller::FIRE_BURNING_MAX;
use crate::first_pass::prop_controller::FIRE_BURNING_OFFSET;
use crate::first_pass::prop_controller::FIRE_PARENT_POSITIONS_MAX;
use crate::first_pass::prop_controller::FIRE_PARENT_POSITIONS_OFFSET;
use crate::first_pass::prop_controller::FIRE_POSITIONS_MAX;
use crate::first_pass::prop_controller::FIRE_POSITIONS_OFFSET;
use crate::first_pass::prop_controller::MY_WEAPONS_OFFSET;
use crate::first_pass::prop_controller::VOXEL_FRAME_DATA_MAX;
use crate::first_pass::prop_controller::VOXEL_FRAME_DATA_OFFSET;
use crate::first_pass::prop_controller::WEAPON_SKIN_ID;
use crate::first_pass::prop_controller::WEAPON_ATTRIBUTE_DEF_INDEX_ID;
use crate::maps::BASETYPE_DECODERS;
use crate::second_pass::decoder::Decoder;
use crate::second_pass::decoder::Decoder::*;
use crate::second_pass::decoder::QfMapper;
use crate::second_pass::decoder::QuantalizedFloat;
use crate::second_pass::path_ops::FieldPath;
use ahash::AHashMap;
use csgoproto::CsvcMsgFlattenedSerializer;
use csgoproto::ProtoFlattenedSerializerFieldT;
use csgoproto::ProtoFlattenedSerializerT;
use lazy_static::lazy_static;
use prost::Message;
use regex::Regex;

lazy_static! {
    static ref RE: Regex = Regex::new(r"([^<\[\*]+)(<\s(.*)\s>)?(\*)?(\[(.*)\])?").unwrap();
}

// Majority of this file is implemented based on how clarity does it: https://github.com/skadistats/clarity
// Majority of this file is implemented based on how clarity does it: https://github.com/skadistats/clarity

#[derive(Debug, Clone)]
pub struct Serializer {
    pub name: String,
    pub fields: Vec<Field>,
}
#[derive(Debug, Clone, Copy)]
pub struct FieldInfo {
    pub decoder: Decoder,
    pub should_parse: bool,
    pub prop_id: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum VectorElementKind {
    WeaponEconAttribute,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct VectorId {
    pub path: [i32; 7],
    pub last: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct VectorRootInfo {
    pub vector_id: VectorId,
    pub element_kind: VectorElementKind,
}

#[derive(Debug, Clone, Copy)]
pub enum ResolvedField {
    Property(FieldInfo),
    VectorLength(VectorRootInfo),
}

impl ResolvedField {
    pub fn property(self) -> Option<FieldInfo> {
        match self {
            Self::Property(info) => Some(info),
            Self::VectorLength(_) => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum FieldCategory {
    Pointer,
    Vector,
    Array,
    Value,
}
#[derive(Debug, Clone)]
pub struct ConstructorField {
    pub var_name: String,
    pub var_type: String,
    pub send_node: String,
    pub serializer_name: Option<String>,
    pub encoder: String,
    pub encode_flags: i32,
    pub bitcount: i32,
    pub low_value: f32,
    pub high_value: f32,
    pub field_type: FieldType,

    pub decoder: Decoder,
    pub category: FieldCategory,
    pub field_enum_type: Option<Field>,
    pub serializer: Option<Serializer>,
    pub base_decoder: Option<Decoder>,
    pub child_decoder: Option<Decoder>,
}
impl<'a> FirstPassParser<'a> {
    pub fn parse_sendtable(&mut self) -> Result<(AHashMap<String, Serializer>, QfMapper, PropController), DemoParserError> {
        let tables = match &self.sendtable_message {
            Some(table) => table,
            None => return Err(DemoParserError::NoSendTableMessage),
        };

        let mut bitreader = Bitreader::new(tables.data());
        let n_bytes = bitreader.read_varint()?;
        let bytes = bitreader.read_n_bytes(n_bytes as usize)?;
        let serializer_msg = match CsvcMsgFlattenedSerializer::decode(bytes.as_slice()) {
            Ok(msg) => msg,
            Err(_) => return Err(DemoParserError::MalformedMessage),
        };
        // TODO MOVE
        if needs_velocity(&self.wanted_player_props) {
            let new_props = vec!["X".to_string(), "Y".to_string(), "Z".to_string()];
            for prop in new_props {
                if !self.wanted_player_props.contains(&prop) {
                    self.added_temp_props.push(prop.to_string());
                    self.wanted_player_props.push(prop.to_string());
                }
            }
        }
        let mut prop_controller = PropController::new(
            self.wanted_player_props.clone(),
            self.wanted_other_props.clone(),
            self.wanted_prop_states.clone(),
            self.real_name_to_og_name.clone(),
            needs_velocity(&self.wanted_player_props),
            &self.wanted_events,
            self.parse_projectiles,
            self.parse_infernos,
        );
        // Quantalized floats have their own helper struct
        let mut qf_mapper = QfMapper {
            idx: 0,
            map: AHashMap::default(),
        };
        let serializers = self.create_fields(&serializer_msg, &mut qf_mapper, &mut prop_controller)?;
        Ok((serializers, qf_mapper, prop_controller))
    }
    fn create_fields(
        &mut self,
        serializer_msg: &CsvcMsgFlattenedSerializer,
        qf_mapper: &mut QfMapper,
        prop_controller: &mut PropController,
    ) -> Result<AHashMap<String, Serializer>, DemoParserError> {
        let mut fields: Vec<Option<ConstructorField>> = vec![None; serializer_msg.fields.len()];
        let mut field_type_map = AHashMap::default();
        let mut serializers: AHashMap<String, Serializer> = AHashMap::default();

        // Creates fields
        for (idx, field) in fields.iter_mut().enumerate() {
            if let Some(f) = &serializer_msg.fields.get(idx) {
                *field = Some(self.generate_field_data(f, &serializer_msg, &mut field_type_map, qf_mapper)?);
            }
        }
        // Creates serializers
        for serializer in &serializer_msg.serializers {
            let mut ser = self.generate_serializer(&serializer, &mut fields, serializer_msg, &mut serializers)?;
            if ser.name.contains("Player")
                || ser.name.contains("Controller")
                || ser.name.contains("Team")
                || ser.name.contains("Weapon")
                || ser.name.contains("AK")
                || ser.name.contains("cell")
                || ser.name.contains("vec")
                || ser.name.contains("Projectile")
                || ser.name.contains("Knife")
                || ser.name.contains("CDEagle")
                || ser.name.contains("Rules")
                || ser.name.contains("C4")
                || ser.name.contains("Grenade")
                || ser.name.contains("Flash")
                || ser.name.contains("Molo")
                || ser.name.contains("Inc")
                || ser.name.contains("Infer")
            {
                // Assign id to each prop and other metadata things.
                // When collecting values we use the id as key.
                prop_controller.find_prop_name_paths(&mut ser);
            }
            serializers.insert(ser.name.clone(), ser);
        }
        // Related to prop collection
        prop_controller.set_custom_propinfos();
        prop_controller.path_to_name = AHashMap::default();
        Ok(serializers)
    }
    fn generate_serializer(
        &mut self,
        serializer_msg: &ProtoFlattenedSerializerT,
        field_data: &mut Vec<Option<ConstructorField>>,
        big: &CsvcMsgFlattenedSerializer,
        serializers: &AHashMap<String, Serializer>,
    ) -> Result<Serializer, DemoParserError> {
        let sid = match big.symbols.get(serializer_msg.serializer_name_sym() as usize) {
            Some(sid) => sid,
            None => return Err(DemoParserError::MalformedMessage),
        };

        // TODO
        // This loop could probably just be an iterator over serializer_msg.fields_index that returns
        // a Field::None by default but could also return whatever is the found field (which
        // currently overwrites the entry) and then collect that iterator into a vec
        let mut fields_this_ser: Vec<Field> = vec![Field::None; serializer_msg.fields_index.len()];
        for (idx, field_this_ser) in fields_this_ser.iter_mut().enumerate() {
            let fi = match serializer_msg.fields_index.get(idx) {
                Some(i) => *i as usize,
                None => continue,
            };

            let f = match field_data.get_mut(fi) {
                Some(Some(f)) => f,
                _ => continue,
            };

            if f.field_enum_type.is_none() {
                f.field_enum_type = Some(create_field(&sid, f, serializers, &mut self.qf_mapper)?)
            }
            if let Some(Some(f)) = &field_data.get(fi) {
                if let Some(field) = &f.field_enum_type {
                    *field_this_ser = field.clone()
                }
            }
        }

        Ok(Serializer {
            name: sid.clone(),
            fields: fields_this_ser,
        })
    }

    fn generate_field_data(
        &mut self,
        msg: &ProtoFlattenedSerializerFieldT,
        big: &CsvcMsgFlattenedSerializer,
        field_type_map: &mut AHashMap<String, FieldType>,
        qf_mapper: &mut QfMapper,
    ) -> Result<ConstructorField, DemoParserError> {
        let name = match big.symbols.get(msg.var_type_sym() as usize) {
            Some(name) => name,
            None => return Err(DemoParserError::MalformedMessage),
        };
        let ft = find_field_type(name, field_type_map)?;
        let mut field = field_from_msg(&msg, &big, ft.clone())?;

        field.category = find_category(&mut field);
        field.decoder = field.find_decoder(qf_mapper);

        match field.var_name.as_str() {
            "m_PredFloatVariables" | "m_OwnerOnlyPredNetFloatVariables" => field.decoder = NoscaleDecoder,
            "m_OwnerOnlyPredNetVectorVariables" | "m_PredVectorVariables" => field.decoder = VectorNoscaleDecoder,
            "m_pGameModeRules" => field.decoder = GameModeRulesDecoder,
            _ => {}
        };
        if field.encoder == "qangle_precise" {
            field.decoder = QanglePresDecoder;
        }
        field.field_type = ft;
        Ok(field)
    }
}

// Design from https://github.com/skadistats/clarity
#[derive(Debug, Clone)]
pub enum Field {
    Array(ArrayField),
    Vector(VectorField),
    Serializer(SerializerField),
    Pointer(PointerField),
    Value(ValueField),
    None,
}

impl Field {
    #[inline(always)]
    pub fn get_inner(&self, idx: usize) -> Result<&Field, DemoParserError> {
        match self {
            Field::Array(inner) => Ok(&inner.field_enum),
            Field::Vector(inner) => Ok(&inner.field_enum),
            Field::Serializer(inner) => match inner.serializer.fields.get(idx) {
                Some(f) => Ok(f),
                None => Err(DemoParserError::IllegalPathOp),
            },
            Field::Pointer(inner) => match inner.serializer.fields.get(idx) {
                Some(f) => Ok(f),
                None => Err(DemoParserError::IllegalPathOp),
            },
            // Illegal
            Field::Value(_) => Err(DemoParserError::IllegalPathOp),
            Field::None => Err(DemoParserError::IllegalPathOp),
        }
    }
    #[inline(always)]
    pub fn get_inner_mut(&mut self, idx: usize) -> Result<&mut Field, DemoParserError> {
        match self {
            Field::Array(inner) => Ok(&mut inner.field_enum),
            Field::Vector(inner) => Ok(&mut inner.field_enum),
            Field::Serializer(inner) => match inner.serializer.fields.get_mut(idx) {
                Some(f) => Ok(f),
                None => Err(DemoParserError::IllegalPathOp),
            },
            Field::Pointer(inner) => match inner.serializer.fields.get_mut(idx) {
                Some(f) => Ok(f),
                None => Err(DemoParserError::IllegalPathOp),
            }, // Illegal
            Field::Value(_) => Err(DemoParserError::IllegalPathOp),
            Field::None => Err(DemoParserError::IllegalPathOp),
        }
    }
    #[inline(always)]
    pub fn get_decoder(&self) -> Option<Decoder> {
        match self {
            Field::Value(inner) => Some(inner.decoder),
            Field::Vector(_) => Some(UnsignedDecoder),
            Field::Pointer(inner) => Some(inner.decoder),
            // Illegal
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ArrayField {
    pub field_enum: Box<Field>,
    pub length: usize,
}
#[derive(Debug, Clone)]
pub struct VectorField {
    pub field_enum: Box<Field>,
    pub decoder: Decoder,
    pub name: String,
    pub send_node: String,
}
#[derive(Debug, Clone, PartialEq)]
pub struct ValueField {
    pub decoder: Decoder,
    pub name: String,
    pub should_parse: bool,
    pub prop_id: u32,
    pub full_name: String,
}

#[derive(Debug, Clone)]
pub struct SerializerField {
    pub serializer: Serializer,
}
#[derive(Debug, Clone)]
pub struct PointerField {
    pub decoder: Decoder,
    pub serializer: Serializer,
}

impl ArrayField {
    pub fn new(field_enum: Field, length: usize) -> ArrayField {
        ArrayField {
            field_enum: Box::new(field_enum),
            length,
        }
    }
}
impl PointerField {
    pub fn new(serializer: &Serializer) -> PointerField {
        let decoder = if serializer.name == "CCSGameModeRules" {
            Decoder::GameModeRulesDecoder
        } else {
            Decoder::BooleanDecoder
        };
        PointerField {
            serializer: serializer.clone(),
            decoder,
        }
    }
}
impl SerializerField {
    pub fn new(serializer: &Serializer) -> SerializerField {
        SerializerField {
            serializer: serializer.clone(),
        }
    }
}
impl ValueField {
    pub fn new(decoder: Decoder, name: &str) -> ValueField {
        ValueField {
            decoder,
            name: name.to_string(),
            prop_id: 0,
            should_parse: false,
            full_name: "".to_string() + name,
        }
    }
}
impl VectorField {
    pub fn new(
        field_enum: Field,
        _f: std::option::Option<Box<FieldType>>,
        name: String,
        send_node: String,
    ) -> VectorField {
        VectorField {
            field_enum: Box::new(field_enum),
            decoder: UnsignedDecoder,
            name,
            send_node,
        }
    }
}
pub fn field_from_msg(
    field: &ProtoFlattenedSerializerFieldT,
    serializer_msg: &CsvcMsgFlattenedSerializer,
    ft: FieldType,
) -> Result<ConstructorField, DemoParserError> {
    let ser_name = match field.field_serializer_name_sym.is_some() {
        true => match serializer_msg.symbols.get(field.field_serializer_name_sym() as usize) {
            Some(entry) => Some(entry.clone()),
            None => return Err(DemoParserError::MalformedMessage),
        },
        false => None,
    };
    let enc_name = match field.var_encoder_sym.is_some() {
        true => match serializer_msg.symbols.get(field.var_encoder_sym() as usize) {
            Some(enc_name) => enc_name.to_owned(),
            None => return Err(DemoParserError::MalformedMessage),
        },
        false => "".to_string(),
    };
    let var_name = match serializer_msg.symbols.get(field.var_name_sym() as usize) {
        Some(entry) => entry.clone(),
        None => return Err(DemoParserError::MalformedMessage),
    };
    let var_type = match serializer_msg.symbols.get(field.var_type_sym() as usize) {
        Some(entry) => entry.clone(),
        None => return Err(DemoParserError::MalformedMessage),
    };
    let send_node = match serializer_msg.symbols.get(field.send_node_sym() as usize) {
        Some(entry) => entry.clone(),
        None => return Err(DemoParserError::MalformedMessage),
    };

    let f = ConstructorField {
        field_enum_type: None,
        bitcount: field.bit_count(),
        var_name,
        var_type,
        send_node,
        serializer_name: ser_name,
        encoder: enc_name,
        encode_flags: field.encode_flags(),
        low_value: field.low_value(),
        high_value: field.high_value(),

        field_type: ft,
        serializer: None,
        decoder: BaseDecoder,
        base_decoder: None,
        child_decoder: None,

        category: FieldCategory::Value,
    };

    Ok(f)
}
#[inline(always)]
pub fn find_field<'b>(fp: &FieldPath, ser: &'b Serializer) -> Result<&'b Field, DemoParserError> {
    let f = match ser.fields.get(fp.path[0] as usize) {
        Some(entry) => entry,
        None => return Err(DemoParserError::IllegalPathOp),
    };
    match fp.last {
        0 => Ok(f),
        1 => Ok(f.get_inner(fp.path[1] as usize)?),
        2 => Ok(f.get_inner(fp.path[1] as usize)?.get_inner(fp.path[2] as usize)?),
        3 => Ok(f
            .get_inner(fp.path[1] as usize)?
            .get_inner(fp.path[2] as usize)?
            .get_inner(fp.path[3] as usize)?),
        4 => Ok(f
            .get_inner(fp.path[1] as usize)?
            .get_inner(fp.path[2] as usize)?
            .get_inner(fp.path[3] as usize)?
            .get_inner(fp.path[4] as usize)?),
        5 => Ok(f
            .get_inner(fp.path[1] as usize)?
            .get_inner(fp.path[2] as usize)?
            .get_inner(fp.path[3] as usize)?
            .get_inner(fp.path[4] as usize)?
            .get_inner(fp.path[5] as usize)?),
        _ => return Err(DemoParserError::IllegalPathOp),
    }
}
pub fn get_decoder_from_field(field: &Field) -> Result<Decoder, DemoParserError> {
    let decoder = match field {
        Field::Value(inner) => inner.decoder,
        Field::Vector(_) => UnsignedDecoder,
        Field::Pointer(inner) => inner.decoder,
        _ => return Err(DemoParserError::FieldNoDecoder),
    };
    Ok(decoder)
}

pub fn get_propinfo(field: &Field, path: &FieldPath) -> Option<FieldInfo> {
    let mut fi = match field {
        Field::Value(v) => FieldInfo {
            decoder: v.decoder,
            should_parse: v.should_parse,
            prop_id: v.prop_id,
        },
        Field::Vector(v) => match field.get_inner(0) {
            Ok(Field::Value(inner)) => FieldInfo {
                decoder: v.decoder,
                should_parse: inner.should_parse,
                prop_id: inner.prop_id,
            },
            _ => return None,
        },
        _ => return None,
    };

    // Flatten vector props
    if fi.prop_id == MY_WEAPONS_OFFSET {
        if path.last == 1 {
            // TODO
            // Why is this part here?
        } else {
            fi.prop_id = MY_WEAPONS_OFFSET + path.path[2] as u32 + 1;
        }
    }
    // CS2 Insight: flatten utility CUtlVector elements by deepest path index.
    let vector_index = path.path[path.last] as u32;
    if fi.prop_id == VOXEL_FRAME_DATA_OFFSET && path.last >= 1 {
        if vector_index < VOXEL_FRAME_DATA_MAX {
            fi.prop_id = VOXEL_FRAME_DATA_OFFSET + 1 + vector_index;
        }
    }
    if fi.prop_id == FIRE_POSITIONS_OFFSET && path.last >= 1 {
        if vector_index < FIRE_POSITIONS_MAX {
            fi.prop_id = FIRE_POSITIONS_OFFSET + 1 + vector_index;
        }
    }
    if fi.prop_id == FIRE_BURNING_OFFSET && path.last >= 1 {
        if vector_index < FIRE_BURNING_MAX {
            fi.prop_id = FIRE_BURNING_OFFSET + 1 + vector_index;
        }
    }
    if fi.prop_id == FIRE_PARENT_POSITIONS_OFFSET && path.last >= 1 {
        if vector_index < FIRE_PARENT_POSITIONS_MAX {
            fi.prop_id = FIRE_PARENT_POSITIONS_OFFSET + 1 + vector_index;
        }
    }
    if fi.prop_id == WEAPON_SKIN_ID {
        fi.prop_id = WEAPON_SKIN_ID + path.path[1] as u32;
    }
    if fi.prop_id == WEAPON_ATTRIBUTE_DEF_INDEX_ID {
        fi.prop_id = WEAPON_ATTRIBUTE_DEF_INDEX_ID + path.path[1] as u32;
    }
    if fi.prop_id == GLOVE_PAINT_ID {
        fi.prop_id = GLOVE_PAINT_ID + path.path[1] as u32;
    }
    // index 14 seems to be for flashbang ammo...
    if fi.prop_id == GRENADE_AMMO_ID && path.path[2] == 14{
        fi.prop_id = FLASHBANG_AMMO_ID;
    }

    if path.path[1] != 1 {
        if fi.prop_id >= ITEM_PURCHASE_COUNT && fi.prop_id < ITEM_PURCHASE_COUNT + FLATTENED_VEC_MAX_LEN {
            fi.prop_id = ITEM_PURCHASE_COUNT + path.path[2] as u32;
        }
        if fi.prop_id >= ITEM_PURCHASE_DEF_IDX && fi.prop_id < ITEM_PURCHASE_DEF_IDX + FLATTENED_VEC_MAX_LEN {
            fi.prop_id = ITEM_PURCHASE_DEF_IDX + path.path[2] as u32;
        }
        if fi.prop_id >= ITEM_PURCHASE_COST && fi.prop_id < ITEM_PURCHASE_COST + FLATTENED_VEC_MAX_LEN {
            fi.prop_id = ITEM_PURCHASE_COST + path.path[2] as u32;
        }
        if fi.prop_id >= ITEM_PURCHASE_HANDLE && fi.prop_id < ITEM_PURCHASE_HANDLE + FLATTENED_VEC_MAX_LEN {
            fi.prop_id = ITEM_PURCHASE_HANDLE + path.path[2] as u32;
        }
        if fi.prop_id >= ITEM_PURCHASE_NEW_DEF_IDX && fi.prop_id < ITEM_PURCHASE_NEW_DEF_IDX + FLATTENED_VEC_MAX_LEN {
            fi.prop_id = ITEM_PURCHASE_NEW_DEF_IDX + path.path[2] as u32;
        }
    }
    return Some(fi);
}

fn field_contains_prop_id(field: &Field, prop_id: u32) -> bool {
    match field {
        Field::Value(value) => value.prop_id == prop_id,
        Field::Serializer(serializer) => serializer
            .serializer
            .fields
            .iter()
            .any(|field| field_contains_prop_id(field, prop_id)),
        Field::Pointer(pointer) => pointer
            .serializer
            .fields
            .iter()
            .any(|field| field_contains_prop_id(field, prop_id)),
        Field::Array(array) => field_contains_prop_id(&array.field_enum, prop_id),
        Field::Vector(vector) => field_contains_prop_id(&vector.field_enum, prop_id),
        Field::None => false,
    }
}

fn get_vector_root_info(field: &Field, path: &FieldPath) -> Option<VectorRootInfo> {
    let Field::Vector(vector) = field else {
        return None;
    };
    if vector
        .send_node
        .ends_with("m_NetworkedDynamicAttributes")
        && field_contains_prop_id(&vector.field_enum, WEAPON_ATTRIBUTE_DEF_INDEX_ID)
        && field_contains_prop_id(&vector.field_enum, WEAPON_SKIN_ID)
    {
        return Some(VectorRootInfo {
            vector_id: VectorId {
                path: path.path,
                last: path.last,
            },
            element_kind: VectorElementKind::WeaponEconAttribute,
        });
    }
    None
}

pub fn get_resolved_propinfo(field: &Field, path: &FieldPath) -> Option<ResolvedField> {
    if let Some(vector_info) = get_vector_root_info(field, path) {
        return Some(ResolvedField::VectorLength(vector_info));
    }
    get_propinfo(field, path).map(ResolvedField::Property)
}

fn create_field(
    _sid: &String,
    fd: &mut ConstructorField,
    serializers: &AHashMap<String, Serializer>,
    qf_mapper: &mut QfMapper,
) -> Result<Field, DemoParserError> {
    let element_type = match fd.category {
        FieldCategory::Array => fd.field_type.element_type.clone(),
        FieldCategory::Vector => fd.field_type.generic_type.clone(),
        _ => Some(Box::new(fd.field_type.clone())),
    };

    let element_field = match fd.serializer_name.as_ref() {
        Some(name) => {
            let ser = match serializers.get(name.as_str()) {
                Some(ser) => ser,
                None => return Err(DemoParserError::MalformedMessage),
            };
            if fd.category == FieldCategory::Pointer {
                Field::Pointer(PointerField::new(ser))
            } else {
                Field::Serializer(SerializerField::new(ser))
            }
        }
        None => Field::Value(ValueField::new(fd.decoder, &fd.var_name)),
    };

    let element_field = match fd.category {
        FieldCategory::Array => Field::Array(ArrayField::new(element_field, fd.field_type.count.unwrap_or(0) as usize)),
        FieldCategory::Vector => Field::Vector(VectorField::new(
            element_field,
            element_type,
            fd.var_name.clone(),
            fd.send_node.clone(),
        )),
        _ => return Ok(element_field),
    };
    Ok(element_field)
}

fn find_field_type(name: &str, field_type_map: &mut AHashMap<String, FieldType>) -> Result<FieldType, DemoParserError> {
    let captures = match RE.captures(name) {
        Some(captures) => captures,
        None => return Err(DemoParserError::MalformedMessage),
    };
    let base_type = match captures.get(1) {
        Some(s) => s.as_str().to_owned(),
        None => "".to_string(),
    };

    let pointer = match captures.get(4) {
        Some(s) => {
            if s.as_str() == "*" {
                true
            } else {
                if POINTER_TYPES.contains(&name) {
                    true
                } else {
                    false
                }
            }
        }
        None => {
            if POINTER_TYPES.contains(&name) {
                true
            } else {
                false
            }
        }
    };

    let mut ft = FieldType {
        base_type,
        pointer,
        generic_type: None,
        count: None,
        element_type: None,
    };

    ft.generic_type = match captures.get(3) {
        Some(generic) => Some(Box::new(find_field_type(generic.as_str(), field_type_map)?)),
        None => None,
    };
    ft.count = match captures.get(6) {
        Some(n) => Some(n.as_str().parse::<i32>().unwrap_or(0)),
        None => None,
    };
    if ft.count.is_some() {
        ft.element_type = Some(Box::new(for_string(field_type_map, to_string(&ft, true))?));
    }
    return Ok(ft);
}

impl ConstructorField {
    pub fn find_decoder(&self, qf_map: &mut QfMapper) -> Decoder {
        if self.var_name == "m_iClip1" {
            return Decoder::AmmoDecoder;
        }
        let dec = match BASETYPE_DECODERS.get(&self.field_type.base_type) {
            Some(decoder) => decoder.clone(),
            None => {
                let name = if let Some(generic_type) = &self.field_type.generic_type {
                    generic_type.base_type.as_str()
                } else {
                    &self.field_type.base_type
                };
                let dc = match name {
                    "float32" => self.find_float_decoder(qf_map),
                    "Vector" => self.find_vector_type(3, qf_map),
                    "Vector2D" => self.find_vector_type(2, qf_map),
                    "VectorWS" => self.find_vector_type(3, qf_map),
                    "Vector4D" => self.find_vector_type(4, qf_map),
                    "uint64" => self.find_uint_decoder(),
                    "QAngle" => self.find_qangle_decoder(),
                    "CHandle" => UnsignedDecoder,
                    "CNetworkedQuantizedFloat" => self.find_float_decoder(qf_map),
                    "CStrongHandle" => self.find_uint_decoder(),
                    "CEntityHandle" => self.find_uint_decoder(),
                    _ => {
                        let name = if let Some(generic_type) = &self.field_type.generic_type {
                            generic_type.base_type.as_str()
                        } else {
                            &self.field_type.base_type
                        };
                        let dec = match BASETYPE_DECODERS.get(name) {
                            Some(d) => d.clone(),
                            None => Decoder::UnsignedDecoder,
                        };
                        dec
                    }
                };
                dc
            }
        };
        dec
    }
    pub fn find_qangle_decoder(&self) -> Decoder {
        match self.var_name.as_str() {
            "m_angEyeAngles" => Decoder::QanglePitchYawDecoder,
            _ => {
                if self.bitcount != 0 {
                    Decoder::Qangle3Decoder(self.bitcount as u8)
                } else {
                    Decoder::QangleVarDecoder
                }
            }
        }
    }
    pub fn find_float_decoder(&self, qf_map: &mut QfMapper) -> Decoder {
        match self.var_name.as_str() {
            "m_flSimulationTime" => return Decoder::FloatSimulationTimeDecoder,
            "m_flAnimTime" => return Decoder::FloatSimulationTimeDecoder,
            _ => {}
        }
        match self.encoder.as_str() {
            "coord" => Decoder::FloatCoordDecoder,
            "m_flSimulationTime" => Decoder::FloatSimulationTimeDecoder,
            _ => {
                if self.bitcount <= 0 || self.bitcount >= 32 {
                    return Decoder::NoscaleDecoder;
                } else {
                    let qf = QuantalizedFloat::new(self.bitcount as u32, Some(self.encode_flags), Some(self.low_value), Some(self.high_value));
                    let idx = qf_map.idx;
                    qf_map.map.insert(idx, qf);
                    qf_map.idx += 1;
                    return Decoder::QuantalizedFloatDecoder(idx as u8);
                }
            }
        }
    }

    pub fn find_uint_decoder(&self) -> Decoder {
        match self.encoder.as_str() {
            "fixed64" => Decoder::Fixed64Decoder,
            _ => Decoder::Unsigned64Decoder,
        }
    }
    pub fn find_vector_type(&self, n: u32, qf_map: &mut QfMapper) -> Decoder {
        if n == 3 && self.encoder == "normal" {
            return Decoder::VectorNormalDecoder;
        }
        let float_type = self.find_float_decoder(qf_map);
        match float_type {
            NoscaleDecoder => return VectorNoscaleDecoder,
            FloatCoordDecoder => return VectorFloatCoordDecoder,
            // This one should not happen
            _ => return Decoder::VectorNormalDecoder,
        }
    }
}

pub fn find_category(field: &mut ConstructorField) -> FieldCategory {
    if is_pointer(&field) {
        return FieldCategory::Pointer;
    }
    if is_vector(&field) {
        return FieldCategory::Vector;
    }
    if is_array(&field) {
        return FieldCategory::Array;
    }
    FieldCategory::Value
}
pub fn is_pointer(field: &ConstructorField) -> bool {
    if field.field_type.pointer {
        return true;
    }

    matches!(
        field.field_type.base_type.as_str(),
        "CBodyComponent" | "CLightComponent" | "CPhysicsComponent" | "CRenderComponent" | "CPlayerLocalData"
    )
}
pub fn is_vector(field: &ConstructorField) -> bool {
    if field.serializer_name.is_some() {
        return true;
    }

    matches!(field.field_type.base_type.as_str(), "CUtlVector" | "CNetworkUtlVectorBase")
}
pub fn is_array(field: &ConstructorField) -> bool {
    if field.field_type.count.is_some() {
        if field.field_type.base_type != "char" {
            return true;
        }
    }
    false
}
fn for_string(field_type_map: &mut AHashMap<String, FieldType>, field_type_string: String) -> Result<FieldType, DemoParserError> {
    match field_type_map.get(&field_type_string) {
        Some(s) => return Ok(s.clone()),
        None => {
            let result = find_field_type(&field_type_string, field_type_map)?;
            field_type_map.insert(field_type_string, result.clone());
            Ok(result.clone())
        }
    }
}
fn to_string(ft: &FieldType, omit_count: bool) -> String {
    // Function is rarely called
    let mut s = "".to_string();

    s = s + &ft.base_type;

    if let Some(gt) = &ft.generic_type {
        s += "< ";
        s += &to_string(&gt, true);
        s += "< ";
    }
    if ft.pointer {
        s += "*";
    }
    if !omit_count && ft.count.is_some() {
        if let Some(c) = ft.count {
            s += "[";
            s += &c.to_string();
            s += "]";
        }
    }
    s
}
pub const POINTER_TYPES: &'static [&'static str] = &["CBodyComponent", "CLightComponent", "CPhysicsComponent", "CRenderComponent", "CPlayerLocalData"];
#[derive(Debug, Clone)]
pub struct FieldType {
    pub base_type: String,
    pub generic_type: Option<Box<FieldType>>,
    pub pointer: bool,
    pub count: Option<i32>,
    pub element_type: Option<Box<FieldType>>,
}

#[cfg(test)]
mod econ_vector_tests {
    use super::*;

    #[test]
    fn econ_vector_serializer_root_resolves_to_length_metadata() {
        let mut definition = ValueField::new(UnsignedDecoder, "m_iAttributeDefinitionIndex");
        definition.prop_id = WEAPON_ATTRIBUTE_DEF_INDEX_ID;
        definition.should_parse = true;
        let mut raw = ValueField::new(NoscaleDecoder, "m_iRawValue32");
        raw.prop_id = WEAPON_SKIN_ID;
        raw.should_parse = true;
        let field = Field::Vector(VectorField {
            field_enum: Box::new(Field::Serializer(SerializerField {
                serializer: Serializer {
                    name: "CEconItemAttribute".to_string(),
                    fields: vec![Field::Value(definition), Field::Value(raw)],
                },
            })),
            decoder: UnsignedDecoder,
            name: "m_Attributes".to_string(),
            send_node: "m_AttributeManager.m_Item.m_NetworkedDynamicAttributes".to_string(),
        });
        let path = FieldPath {
            path: [4, 0, 0, 0, 0, 0, 0],
            last: 0,
        };

        assert!(matches!(
            get_resolved_propinfo(&field, &path),
            Some(ResolvedField::VectorLength(VectorRootInfo {
                vector_id: VectorId {
                    path: [4, 0, 0, 0, 0, 0, 0],
                    last: 0,
                },
                element_kind: VectorElementKind::WeaponEconAttribute,
            }))
        ));

        let mut static_attributes = field.clone();
        let Field::Vector(vector) = &mut static_attributes else {
            unreachable!();
        };
        vector.send_node = "m_AttributeManager.m_Item.m_AttributeList".to_string();
        assert!(get_resolved_propinfo(&static_attributes, &path).is_none());
    }
}
