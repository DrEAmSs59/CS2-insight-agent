use crate::entity::field::*;
use crate::error::SerializerError;
use crate::HashMap;
use std::cell::UnsafeCell;
use std::rc::Rc;

struct CacheCell<T>(UnsafeCell<T>);

impl<T> CacheCell<T> {
    fn new(value: T) -> Self {
        Self(UnsafeCell::new(value))
    }

    #[inline(always)]
    fn get(&self) -> &T {
        unsafe { &*self.0.get() }
    }
}

#[derive(Clone)]
pub(crate) struct Serializer {
    pub(crate) fields: Vec<Rc<Field>>,
    fp_cache: Rc<CacheCell<HashMap<Box<str>, FieldPath>>>,
    name_cache: Rc<CacheCell<HashMap<FieldPath, Rc<str>>>>,
}

impl Default for Serializer {
    fn default() -> Self {
        Self {
            fields: Vec::new(),
            fp_cache: Rc::new(CacheCell::new(HashMap::default())),
            name_cache: Rc::new(CacheCell::new(HashMap::default())),
        }
    }
}

impl Serializer {
    #[inline]
    pub(crate) fn get_name(&self, fp: &FieldPath) -> Rc<str> {
        if let Some(name) = self.name_cache.get().get(fp) {
            return name.clone();
        }

        let mut i = 0;
        let mut current_serializer = self;
        let mut current_field = &current_serializer.fields[fp.path[i] as usize];
        let mut name = String::new();
        loop {
            current_field.append_name(&mut name);
            i += 1;
            match &current_field.model {
                FieldModel::Array | FieldModel::ValueVector(_) => {
                    if i > fp.last {
                        break;
                    }

                    name += &format!(".{:04}", fp.path[i]);

                    break;
                }
                FieldModel::Vector(serializer) => {
                    if i > fp.last {
                        break;
                    }

                    name += &format!(".{:04}.", fp.path[i]);

                    i += 1;

                    current_serializer = serializer;
                }
                FieldModel::Pointer(serializer) => {
                    if i > fp.last {
                        break;
                    }

                    name += ".";

                    current_serializer = serializer;
                }
                FieldModel::Value => break,
            }
            current_field = &current_serializer.fields[fp.path[i] as usize];
        }
        let name = Rc::<str>::from(name);
        unsafe {
            (*self.name_cache.0.get()).insert(*fp, name.clone());
        }
        name
    }

    #[inline]
    pub(crate) fn get_type(&self, fp: &FieldPath) -> &FieldType {
        let mut i = 0;
        let mut current_serializer = self;
        let mut current_field = &current_serializer.fields[fp.path[i] as usize];
        loop {
            i += 1;
            match &current_field.model {
                FieldModel::Value | FieldModel::Array => return current_field.field_type.as_ref(),
                FieldModel::ValueVector(_) => {
                    if i == fp.last {
                        return current_field.field_type.as_ref().generic.as_ref().unwrap();
                    }
                    return current_field.field_type.as_ref();
                }
                FieldModel::Vector(serializer) => {
                    if i >= fp.last {
                        return current_field.field_type.as_ref();
                    }

                    i += 1;

                    current_serializer = serializer;
                }
                FieldModel::Pointer(serializer) => {
                    if i > fp.last {
                        return current_field.field_type.as_ref();
                    }

                    current_serializer = serializer;
                }
            }
            current_field = &current_serializer.fields[fp.path[i] as usize];
        }
    }

    #[inline]
    pub(crate) fn get_decoder(&self, fp: &FieldPath) -> &FieldDecoder {
        let mut i = 0;
        let mut current_serializer = self;
        let mut current_field = &current_serializer.fields[fp.path[i] as usize];
        loop {
            i += 1;
            match &current_field.model {
                FieldModel::Value | FieldModel::Array => return &current_field.decoder,
                FieldModel::ValueVector(decoder) => {
                    if i == fp.last {
                        return decoder;
                    }
                    return &current_field.decoder;
                }
                FieldModel::Vector(serializer) => {
                    if i >= fp.last {
                        return &current_field.decoder;
                    }

                    i += 1;

                    current_serializer = serializer;
                }
                FieldModel::Pointer(serializer) => {
                    if i > fp.last {
                        return &current_field.decoder;
                    }

                    current_serializer = serializer;
                }
            }
            current_field = &current_serializer.fields[fp.path[i] as usize];
        }
    }

    #[inline]
    pub(crate) fn get_path(&self, name: &str) -> Result<FieldPath, SerializerError> {
        if let Some(&fp) = self.fp_cache.get().get(name) {
            return Ok(fp);
        }

        let mut current_serializer = self;
        let mut fp = FieldPath::default();
        let mut offset = 0;
        'outer: loop {
            for (i, f) in current_serializer.fields.iter().enumerate() {
                let Some(field_name_len) = f.name_match_len(name, offset) else {
                    continue;
                };

                if name.len() == offset + field_name_len {
                    fp.path[fp.last] = i as u16;
                    break 'outer;
                }

                if name.as_bytes().get(offset + field_name_len) == Some(&b'.') {
                    fp.path[fp.last] = i as u16;
                    fp.last += 1;
                    offset += field_name_len + 1;
                    match &f.model {
                        FieldModel::Array | FieldModel::ValueVector(_) => {
                            fp.path[fp.last] = name[offset..].parse::<u16>().unwrap();
                            break 'outer;
                        }
                        FieldModel::Vector(serializer) => {
                            fp.path[fp.last] = name[offset..(offset + 4)].parse::<u16>().unwrap();
                            fp.last += 1;
                            offset += 5;
                            current_serializer = serializer;
                            continue 'outer;
                        }
                        FieldModel::Pointer(serializer) => {
                            current_serializer = serializer;
                            continue 'outer;
                        }
                        FieldModel::Value => unreachable!(),
                    }
                }
            }
            return Err(SerializerError::NoFieldPath(name.to_string()));
        }

        unsafe {
            let name: Box<str> = name.into();
            (*self.name_cache.0.get()).insert(fp, Rc::from(name.as_ref()));
            (*self.fp_cache.0.get()).insert(name, fp);
        }

        Ok(fp)
    }

    pub(crate) fn get_paths<'a>(
        &'a self,
        fp: &'a mut FieldPath,
        st: &'a FieldState,
    ) -> Vec<FieldPath> {
        self.fields
            .iter()
            .enumerate()
            .flat_map(|(i, f)| {
                fp.path[fp.last] = i as u16;
                f.get_paths(fp, st)
            })
            .collect::<Vec<_>>()
    }
}
