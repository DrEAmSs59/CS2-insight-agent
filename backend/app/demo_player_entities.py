"""Read-only Demo controller/Pawn relationships, independent of capture backend."""


def network_entity_index(handle) -> int | None:
    # Demo network handles have 14 entry bits; live native handles have 15.
    if handle is None or int(handle) in (-1, 0xFFFFFF, 0xFFFFFFFF):
        return None
    return int(handle) & 0x3FFF


def live_player_entities(row) -> tuple[int, int] | None:
    if not row or not row.get("is_alive"):
        return None
    slot = network_entity_index(row.get("CCSPlayerPawn.m_hController"))
    pawn = row.get("entity_id")
    if (slot is None or not 1 <= slot <= 64 or pawn is None or not 0 < int(pawn) < 0x4000
            or network_entity_index(row.get("CCSPlayerController.m_hPlayerPawn")) != int(pawn)):
        return None
    return slot, int(pawn)
