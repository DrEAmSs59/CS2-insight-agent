use crate::error::ParserError;
use crate::parser::demo::svc::SvcMsg;
use crate::proto::*;
use crate::reader::{BitsReader, MessageReader};
use crate::{try_observers, GameEvent, GameEventList};
use crate::{Interests, Parser};

#[cfg(feature = "dota")]
use crate::event::CombatLogEntry;

pub trait DemoMessages {
    fn on_base_user_message(
        &mut self,
        msg_type: EBaseUserMessages,
        msg: &[u8],
    ) -> Result<(), ParserError>;
    fn on_base_game_event(
        &mut self,
        msg_type: EBaseGameEvents,
        msg: &[u8],
    ) -> Result<(), ParserError>;

    fn on_svc_message(&mut self, msg_type: SvcMessages, msg: &[u8]) -> Result<(), ParserError>;

    fn on_net_message(&mut self, msg_type: NetMessages, msg: &[u8]) -> Result<(), ParserError>;

    fn on_tick_start(&mut self, msg_tick: u32) -> Result<(), ParserError>;

    fn on_tick_end(&mut self) -> Result<(), ParserError>;

    fn on_stop(&mut self) -> Result<(), ParserError>;

    #[cfg(feature = "dota")]
    fn on_dota_user_message(
        &mut self,
        msg_type: EDotaUserMessages,
        msg: &[u8],
    ) -> Result<(), ParserError>;

    #[cfg(feature = "deadlock")]
    fn on_citadel_game_event(
        &mut self,
        msg_type: ECitadelGameEvents,
        msg: &[u8],
    ) -> Result<(), ParserError>;

    #[cfg(feature = "deadlock")]
    fn on_citadel_user_message(
        &mut self,
        msg_type: CitadelUserMessageIds,
        msg: &[u8],
    ) -> Result<(), ParserError>;

    #[cfg(feature = "cs2")]
    fn on_cs2_user_message(
        &mut self,
        msg_type: ECstrike15UserMessages,
        msg: &[u8],
    ) -> Result<(), ParserError>;

    #[cfg(feature = "cs2")]
    fn on_cs2_game_event(
        &mut self,
        msg_type: ECsgoGameEvents,
        msg: &[u8],
    ) -> Result<(), ParserError>;
}

impl<'a, R> DemoMessages for Parser<'a, R>
where
    R: BitsReader + MessageReader,
{
    fn on_base_user_message(
        &mut self,
        msg_type: EBaseUserMessages,
        msg: &[u8],
    ) -> Result<(), ParserError> {
        try_observers!(
            self,
            BASE_USER_MESSAGE,
            on_base_user_message(&self.context, msg_type, msg)
        )?;
        Ok(())
    }

    fn on_base_game_event(
        &mut self,
        msg_type: EBaseGameEvents,
        msg: &[u8],
    ) -> Result<(), ParserError> {
        if self.anyone_interested(Interests::BASE_GAME_EVENT) {
            if msg_type == EBaseGameEvents::GeSource1LegacyGameEventList {
                self.context.game_events = GameEventList::new(CSvcMsgGameEventList::decode(msg)?);
            }

            if msg_type == EBaseGameEvents::GeSource1LegacyGameEvent {
                let ge = GameEvent::new(&self.context.game_events, CSvcMsgGameEvent::decode(msg)?);
                try_observers!(self, BASE_GAME_EVENT, on_game_event(&self.context, &ge))?;
            }

            try_observers!(
                self,
                BASE_GAME_EVENT,
                on_base_game_event(&self.context, msg_type, msg)
            )?;
        }
        Ok(())
    }

    fn on_svc_message(&mut self, msg_type: SvcMessages, msg: &[u8]) -> Result<(), ParserError> {
        match msg_type {
            SvcMessages::SvcServerInfo => self.server_info(CSvcMsgServerInfo::decode(msg)?)?,
            SvcMessages::SvcCreateStringTable => {
                let msg = CSvcMsgCreateStringTable::decode(msg)?;
                self.create_string_table(msg)?
            }
            SvcMessages::SvcUpdateStringTable => {
                if self.anyone_interested(Interests::STRING_TABLE_STATE) {
                    let msg = CSvcMsgUpdateStringTable::decode(msg)?;
                    self.update_string_table(msg)?
                } else if self.anyone_interested(Interests::ENTITY_STATE) {
                    let msg = CSvcMsgUpdateStringTable::decode(msg)?;
                    if self.context.string_tables.tables[msg.table_id() as usize].name
                        == "instancebaseline"
                    {
                        self.update_string_table(msg)?
                    }
                }
            }
            SvcMessages::SvcPacketEntities if self.anyone_interested(Interests::ENTITY_STATE) => {
                self.packet_entities(CSvcMsgPacketEntities::decode(msg)?)?
            }
            _ => {}
        }

        try_observers!(
            self,
            SVC_MESSAGE,
            on_svc_message(&self.context, msg_type, msg)
        )?;
        Ok(())
    }

    fn on_net_message(&mut self, msg_type: NetMessages, msg: &[u8]) -> Result<(), ParserError> {
        if msg_type == NetMessages::NetTick {
            self.context.net_tick = CNetMsgTick::decode(msg)?.tick();
        }

        try_observers!(
            self,
            NET_MESSAGE,
            on_net_message(&self.context, msg_type, msg)
        )?;
        Ok(())
    }

    fn on_tick_start(&mut self, msg_tick: u32) -> Result<(), ParserError> {
        if msg_tick > self.context.tick {
            self.on_tick_end()?;
        }

        self.context.previous_tick = self.context.tick;
        self.context.tick = msg_tick;

        if self.context.previous_tick == msg_tick {
            return Ok(());
        }

        try_observers!(self, TICK_START, on_tick_start(&self.context))?;
        Ok(())
    }

    fn on_tick_end(&mut self) -> Result<(), ParserError> {
        #[cfg(feature = "dota")]
        if self.anyone_interested(Interests::STRING_TABLE_STATE | Interests::COMBAT_LOG_ENTRIES) {
            if let Ok(names) = self.context.string_tables.get_by_name("CombatLogNames") {
                while let Some(log) = self.combat_log.pop_front() {
                    let entry = CombatLogEntry { names, log };
                    try_observers!(
                        self,
                        COMBAT_LOG_ENTRIES,
                        on_combat_log(&self.context, &entry)
                    )?;
                }
            }
        }

        try_observers!(self, TICK_END, on_tick_end(&self.context))?;
        Ok(())
    }

    fn on_stop(&mut self) -> Result<(), ParserError> {
        try_observers!(self, REPLAY_END, on_stop(&self.context))?;
        Ok(())
    }

    #[cfg(feature = "dota")]
    fn on_dota_user_message(
        &mut self,
        msg_type: EDotaUserMessages,
        msg: &[u8],
    ) -> Result<(), ParserError> {
        if self.anyone_interested(Interests::COMBAT_LOG_ENTRIES)
            && msg_type == EDotaUserMessages::DotaUmCombatLogDataHltv
        {
            let entry = CMsgDotaCombatLogEntry::decode(msg)?;
            self.combat_log.push_back(entry);
        }

        try_observers!(
            self,
            DOTA_USER_MESSAGE,
            on_dota_user_message(&self.context, msg_type, msg)
        )?;
        Ok(())
    }

    #[cfg(feature = "deadlock")]
    fn on_citadel_game_event(
        &mut self,
        msg_type: ECitadelGameEvents,
        msg: &[u8],
    ) -> Result<(), ParserError> {
        try_observers!(
            self,
            CITADEL_GAME_EVENT,
            on_citadel_game_event(&self.context, msg_type, msg)
        )?;
        Ok(())
    }

    #[cfg(feature = "deadlock")]
    fn on_citadel_user_message(
        &mut self,
        msg_type: CitadelUserMessageIds,
        msg: &[u8],
    ) -> Result<(), ParserError> {
        try_observers!(
            self,
            CITADEL_USER_MESSAGE,
            on_citadel_user_message(&self.context, msg_type, msg)
        )?;
        Ok(())
    }

    #[cfg(feature = "cs2")]
    fn on_cs2_user_message(
        &mut self,
        msg_type: ECstrike15UserMessages,
        msg: &[u8],
    ) -> Result<(), ParserError> {
        try_observers!(
            self,
            CS2_USER_MESSAGE,
            on_cs2_user_message(&self.context, msg_type, msg)
        )?;
        Ok(())
    }

    #[cfg(feature = "cs2")]
    fn on_cs2_game_event(
        &mut self,
        msg_type: ECsgoGameEvents,
        msg: &[u8],
    ) -> Result<(), ParserError> {
        try_observers!(
            self,
            CS2_GAME_EVENT,
            on_cs2_game_event(&self.context, msg_type, msg)
        )?;
        Ok(())
    }
}
