use crate::entity::field::*;
use crate::entity::Class;
use crate::error::ParserError;
use crate::parser::demo::DemoMessages;
use crate::parser::Parser;
use crate::proto::*;
use crate::reader::*;
use crate::HashMap;
use crate::StringTableRow;
use std::rc::Rc;

pub trait DemoCommands {
    fn dem_send_tables(&mut self, send_tables: CDemoSendTables) -> Result<(), ParserError>;

    fn dem_class_info(&mut self, class_info: CDemoClassInfo) -> Result<(), ParserError>;

    fn dem_packet(&mut self, demo_packet: CDemoPacket) -> Result<(), ParserError>;

    fn dem_full_packet(&mut self, full_packet: CDemoFullPacket) -> Result<(), ParserError>;

    fn dem_string_tables(&mut self, string_tables: CDemoStringTables) -> Result<(), ParserError>;

    fn dem_stop(&mut self) -> Result<(), ParserError> {
        Ok(())
    }
}

impl<'a, R> DemoCommands for Parser<'a, R>
where
    R: BitsReader + MessageReader,
{
    fn dem_send_tables(&mut self, send_tables: CDemoSendTables) -> Result<(), ParserError> {
        let serializers = &mut self.context.serializers;

        let mut reader = SliceReader::new(send_tables.data());
        let amount = reader.read_var_u32();
        let buf = reader.read_bytes(amount);

        let fs = CSvcMsgFlattenedSerializer::decode(buf.as_slice())?;

        let resolve = |p: Option<i32>| -> &str {
            if let Some(i) = p {
                return &fs.symbols[i as usize];
            }
            ""
        };

        let mut fields: Vec<Rc<Field>> = vec![];
        let mut field_types: HashMap<&str, Rc<FieldType>> = HashMap::default();
        let mut symbols: HashMap<i32, Rc<str>> = HashMap::default();

        for s in fs.serializers.iter() {
            let ser_name = resolve(s.serializer_name_sym);
            let mut serializer = Serializer::default();

            for i in s.fields_index.iter().map(|&x| x as usize) {
                let current_field = &fs.fields[i];
                let field_serializer_name = resolve(current_field.field_serializer_name_sym);

                if i >= fields.len() {
                    let var_type_str = resolve(current_field.var_type_sym);
                    let var_name = resolve(current_field.var_name_sym);
                    let send_node = current_field.send_node_sym.and_then(|symbol| {
                        let value = fs.symbols[symbol as usize].as_str();
                        if value.is_empty() || value == "(root)" {
                            return None;
                        }

                        symbols
                            .entry(symbol)
                            .or_insert_with(|| value.into())
                            .clone()
                            .into()
                    });

                    let current_field_serializer = serializers.get(field_serializer_name);

                    let field_type = field_types
                        .entry(var_type_str)
                        .or_insert_with(|| Rc::new(FieldType::new(var_type_str)))
                        .clone();

                    let properties = FieldProperties {
                        encoder: match var_name {
                            "m_flSimulationTime" | "m_flAnimTime" => Some(FieldEncoder::SimTime),
                            "m_flRuneTime" => Some(FieldEncoder::RuneTime),
                            _ => FieldEncoder::from_str(resolve(current_field.var_encoder_sym)),
                        },
                        encoder_flags: current_field.encode_flags(),
                        bit_count: current_field.bit_count(),
                        low_value: current_field.low_value(),
                        high_value: current_field.high_value(),
                    };

                    let model = if let Some(ser) = current_field_serializer {
                        if field_type.pointer {
                            FieldModel::Pointer(ser.clone())
                        } else {
                            FieldModel::Vector(ser.clone())
                        }
                    } else if matches!(
                        field_type.base.as_ref(),
                        "CUtlVector" | "CNetworkUtlVectorBase" | "CUtlVectorEmbeddedNetworkVar"
                    ) {
                        FieldModel::ValueVector(FieldDecoder::from_field(
                            field_type.generic.as_ref().unwrap(),
                            properties,
                        ))
                    } else if field_type.count > 0 && field_type.base.as_ref() != "char" {
                        FieldModel::Array
                    } else {
                        FieldModel::Value
                    };

                    let mut decoder = match model {
                        FieldModel::Value | FieldModel::Array => {
                            FieldDecoder::from_field(&field_type, properties)
                        }
                        FieldModel::Vector(_) | FieldModel::ValueVector(_) => {
                            FieldDecoder::Unsigned32
                        }
                        FieldModel::Pointer(_) => FieldDecoder::Boolean,
                    };

                    if ser_name == "CCSGameModeRules" || var_name == "m_pGameModeRules" {
                        decoder = FieldDecoder::CCSGameModeRules;
                    }

                    let field = Field {
                        var_name: var_name.into(),
                        send_node,
                        field_type,
                        model,
                        decoder,
                    };
                    fields.push(field.into());
                }
                serializer.fields.push(Rc::clone(&fields[i]));
            }
            serializers.insert(ser_name.into(), serializer.into());
        }
        Ok(())
    }

    fn dem_class_info(&mut self, class_info: CDemoClassInfo) -> Result<(), ParserError> {
        for class in class_info.classes {
            let class_id = class.class_id();
            let network_name = class.network_name();
            let serializer = self.context.serializers[network_name].clone();
            let class = Rc::new(Class::new(class_id, network_name.into(), serializer));

            self.context.classes.classes_vec.push(class.clone());
            self.context
                .classes
                .classes_by_name
                .insert(network_name.into(), class);
        }
        Ok(())
    }

    fn dem_packet(&mut self, packet: CDemoPacket) -> Result<(), ParserError> {
        let mut packet_reader = SliceReader::new(packet.data());
        while packet_reader.remaining_bytes() != 0 {
            let msg_type = packet_reader.read_ubit_var() as i32;
            let size = packet_reader.read_var_u32();
            let msg_buf = packet_reader.read_bytes(size);

            #[cfg(feature = "dota")]
            if let Ok(msg) = EDotaUserMessages::try_from(msg_type) {
                self.on_dota_user_message(msg, &msg_buf)?;
                continue;
            }

            #[cfg(feature = "deadlock")]
            if let Ok(msg) = CitadelUserMessageIds::try_from(msg_type) {
                self.on_citadel_user_message(msg, &msg_buf)?;
                continue;
            } else if let Ok(msg) = ECitadelGameEvents::try_from(msg_type) {
                self.on_citadel_game_event(msg, &msg_buf)?;
                continue;
            }

            #[cfg(feature = "cs2")]
            if let Ok(msg) = ECstrike15UserMessages::try_from(msg_type) {
                self.on_cs2_user_message(msg, &msg_buf)?;
                continue;
            } else if let Ok(msg) = ECsgoGameEvents::try_from(msg_type) {
                self.on_cs2_game_event(msg, &msg_buf)?;
                continue;
            }

            if let Ok(msg) = SvcMessages::try_from(msg_type) {
                self.on_svc_message(msg, &msg_buf)?;
            } else if let Ok(msg) = EBaseUserMessages::try_from(msg_type) {
                self.on_base_user_message(msg, &msg_buf)?;
            } else if let Ok(msg) = EBaseGameEvents::try_from(msg_type) {
                self.on_base_game_event(msg, &msg_buf)?;
            } else if let Ok(msg) = NetMessages::try_from(msg_type) {
                self.on_net_message(msg, &msg_buf)?;
            }
        }

        Ok(())
    }

    fn dem_full_packet(&mut self, full_packet: CDemoFullPacket) -> Result<(), ParserError> {
        if self.context.last_full_packet_tick == u32::MAX || self.skip_deltas {
            self.dem_string_tables(full_packet.string_table.unwrap())?;
            self.dem_packet(full_packet.packet.unwrap())?;
        }

        self.context.last_full_packet_tick = self.context.tick;

        Ok(())
    }

    fn dem_string_tables(&mut self, msg: CDemoStringTables) -> Result<(), ParserError> {
        for table in msg.tables.iter() {
            let x = self
                .context
                .string_tables
                .get_by_name_mut(table.table_name())?;

            x.items
                .resize_with(table.items.len(), StringTableRow::default);
            for (i, item) in table.items.iter().enumerate() {
                x.items[i].index = i as i32;
                x.items[i].key = item.str().to_string();
                x.items[i].value = Rc::new(item.data().to_vec()).into();
                if table.table_name() == "instancebaseline" {
                    self.context.baselines.add_baseline(
                        item.str().parse().unwrap_or(-1),
                        x.items[i].value.as_ref().unwrap().clone(),
                    );
                }
            }
        }

        Ok(())
    }

    fn dem_stop(&mut self) -> Result<(), ParserError> {
        self.on_stop()?;
        Ok(())
    }
}
