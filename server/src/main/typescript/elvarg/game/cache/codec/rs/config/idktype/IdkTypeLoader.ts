import { Archive } from "../../cache/Archive";
import { CacheInfo } from "../../cache/CacheInfo";
import { ArchiveTypeLoader, TypeLoader } from "../TypeLoader";
import { IdkType } from "./IdkType";

export type IdkTypeLoader = TypeLoader<IdkType>;

export class ArchiveIdkTypeLoader extends ArchiveTypeLoader<IdkType> implements IdkTypeLoader {
    constructor(cacheInfo: CacheInfo, archive: Archive) {
        super(IdkType, cacheInfo, archive);
    }
}
