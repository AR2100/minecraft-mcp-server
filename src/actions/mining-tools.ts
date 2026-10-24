import minecraftData from 'minecraft-data';
import mineflayer from 'mineflayer';

const TOOL_PRIORITY = [
  'netherite',
  'diamond',
  'iron',
  'copper',
  'stone',
  'golden',
  'wooden'
];

export type InventoryItem = ReturnType<mineflayer.Bot['inventory']['items']>[number];
export type MinecraftBlockData = ReturnType<typeof minecraftData>['blocksByName'][string];

type ToolCategory = 'axe' | 'hoe' | 'pickaxe' | 'shovel';

export function findCompatibleMiningTool(
  bot: mineflayer.Bot,
  blockData: MinecraftBlockData,
  blockType: string,
  expectedDropItem?: string,
  avoidSilkTouch = false
): InventoryItem | undefined {
  const toolCategory = getToolCategory(blockData.material);
  const candidates = bot.inventory.items().filter(item => {
    if (toolCategory && !item.name.endsWith(`_${toolCategory}`)) {
      return false;
    }
    return !blockData.harvestTools || blockData.harvestTools[item.type] === true;
  });

  candidates.sort((first, second) => getToolPriority(first.name) - getToolPriority(second.name));

  const mustAvoidSilkTouch = avoidSilkTouch ||
    (expectedDropItem !== undefined && expectedDropItem !== blockType);
  const usableTools = candidates.filter(item =>
    !mustAvoidSilkTouch || !item.enchants.some(enchantment => enchantment.name === 'silk_touch')
  );

  if (usableTools.length === 0 && (toolCategory || blockData.harvestTools)) {
    if (mustAvoidSilkTouch && candidates.length > 0) {
      throw new Error(
        `The available tool for '${blockType}' has Silk Touch, which may change its drop. ` +
        'Provide a non-Silk-Touch tool.'
      );
    }
    const requiredTool = toolCategory ? `a compatible ${toolCategory}` : 'a compatible tool';
    throw new Error(`The bot needs ${requiredTool} in its inventory to harvest '${blockType}'.`);
  }

  return usableTools[0];
}

function getToolCategory(material?: string): ToolCategory | undefined {
  const match = material?.match(/^mineable\/(axe|hoe|pickaxe|shovel)$/);
  return match?.[1] as ToolCategory | undefined;
}

function getToolPriority(itemName: string): number {
  const material = TOOL_PRIORITY.findIndex(tier => itemName.startsWith(`${tier}_`));
  return material === -1 ? TOOL_PRIORITY.length : material;
}
