#[derive(Clone, Debug)]
pub(crate) struct FieldType {
    pub base: Box<str>,
    pub generic: Option<Box<FieldType>>,
    pub pointer: bool,
    pub count: i32,
}

impl FieldType {
    pub fn new(name: &str) -> Self {
        let mut base_end = name.len();
        let mut pointer = false;
        let mut count = 0;
        let mut generic = None;

        if name.ends_with('*') {
            pointer = true;
            base_end -= 1;
        } else if [
            "CBodyComponent",
            "CLightComponent",
            "CPhysicsComponent",
            "CRenderComponent",
            "CPlayerLocalData",
        ]
        .contains(&name)
        {
            pointer = true;
        }

        if let Some(open_bracket_pos) = name.find('[') {
            let close_bracket_pos = name.find(']').unwrap();
            count = match &name[(open_bracket_pos + 1)..close_bracket_pos] {
                "MAX_ITEM_STOCKS" => 8,
                "MAX_ABILITY_DRAFT_ABILITIES" => 48,
                "DOTA_ABILITY_DRAFT_HEROES_PER_GAME" => 10,
                s => s.parse::<i32>().unwrap_or_default(),
            };
            base_end = open_bracket_pos;
        }

        if let Some(open_angle_pos) = name.find('<') {
            let close_angle_pos = name.rfind('>').unwrap();
            generic = Some(Box::new(FieldType::new(
                name[(open_angle_pos + 1)..close_angle_pos].trim(),
            )));
            base_end = open_angle_pos;
        }

        let mut base = name[..base_end].trim().to_string().into_boxed_str();

        if base.as_ref() == "char" && count == 0 {
            base = "uint8".into();
        }

        FieldType {
            base,
            generic,
            pointer,
            count,
        }
    }
}
