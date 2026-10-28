#if defined _pawn_ide_gameplay
    #endinput
#endif
#define _pawn_ide_gameplay
#include "config.inc"

stock WelcomePlayer(playerid)
{
    SendClientMessage(playerid, WELCOME_COLOUR, "Welcome to the Pawn IDE integration fixture.");
    return 1;
}
