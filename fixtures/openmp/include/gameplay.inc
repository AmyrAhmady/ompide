#if defined _ompide_gameplay
    #endinput
#endif
#define _ompide_gameplay
#include "config.inc"

stock WelcomePlayer(playerid)
{
    SendClientMessage(playerid, WELCOME_COLOUR, "Welcome to the ompide integration fixture.");
    return 1;
}
