import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  type ChatInputApplicationCommandData,
  type ChatInputCommandInteraction,
  InteractionContextType,
} from 'discord.js';
import { COMMANDS } from '../core/menu.js';

export function slashCommands(): ChatInputApplicationCommandData[] {
  return COMMANDS.map((command) => ({
    type: ApplicationCommandType.ChatInput as const,
    name: command.name,
    description: command.description,
    contexts: [InteractionContextType.BotDM],
    integrationTypes: [ApplicationIntegrationType.GuildInstall],
    options:
      'arg' in command
        ? [
            {
              type: ApplicationCommandOptionType.String,
              name: command.arg.name,
              description: command.arg.description,
              required: command.arg.required,
            },
          ]
        : [],
  }));
}

/** "/city name:Wellington New Zealand" → "/city Wellington New Zealand" */
export function interactionText(
  interaction: Pick<ChatInputCommandInteraction, 'commandName' | 'options'>,
) {
  const command = COMMANDS.find((c) => c.name === interaction.commandName);
  const arg =
    command && 'arg' in command ? (interaction.options.getString(command.arg.name) ?? '') : '';
  return `/${interaction.commandName} ${arg}`.trim();
}
