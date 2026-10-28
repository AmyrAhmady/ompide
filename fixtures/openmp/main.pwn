#define MAX_PLAYERS (32)
#include <open.mp>
#include "include/gameplay.inc"

main() {}

public OnGameModeInit()
{
    SetGameModeText(GAMEMODE_NAME);
    AddPlayerClass(0, SPAWN_X, SPAWN_Y, SPAWN_Z, 0.0, WEAPON_FIST, 0, WEAPON_FIST, 0, WEAPON_FIST, 0);
    return 1;
}

public OnPlayerConnect(playerid)
{
    WelcomePlayer(playerid);
    return 1;
}

public OnPlayerSpawn(playerid)
{
    SetPlayerPos(playerid, SPAWN_X, SPAWN_Y, SPAWN_Z);
    return 1;
}
