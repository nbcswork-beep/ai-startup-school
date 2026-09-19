export function registerIdCommand(bot) {
  bot.command('id', async (ctx) => {
    if (ctx.from?.id === undefined) return;
    await ctx.reply(String(ctx.from.id));
  });
}
