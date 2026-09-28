#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edition {
    Free,
    Pro,
}

pub const CURRENT: Edition = Edition::Free;

impl Edition {
    pub fn id(self) -> &'static str {
        match self {
            Edition::Free => "free",
            Edition::Pro => "pro",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Edition::Free => "CS2 洞察免费版",
            Edition::Pro => "CS2 洞察 Pro",
        }
    }

    pub fn other(self) -> Edition {
        match self {
            Edition::Free => Edition::Pro,
            Edition::Pro => Edition::Free,
        }
    }
}
