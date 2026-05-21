export { typstLoader } from './loader.js';
export function combineLoaders(...loaders) {
    return {
        name: loaders.map(l => l.name).join('+'),
        async load(context) {
            await Promise.all(loaders.map(l => l.load(context)));
        },
    };
}
