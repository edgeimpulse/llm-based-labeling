/**
 * Edge Impulse API
 * No description provided (generated by Openapi Generator https://github.com/openapitools/openapi-generator)
 *
 * The version of the OpenAPI document: 1.0.0
 * 
 *
 * NOTE: This class is auto generated by OpenAPI Generator (https://openapi-generator.tech).
 * https://openapi-generator.tech
 * Do not edit the class manually.
 */

import { ModelVariantStats } from './modelVariantStats';

export class EvaluateJobResponseAllOf {
    'result': Array<ModelVariantStats>;

    static discriminator: string | undefined = undefined;

    static attributeTypeMap: Array<{name: string, baseName: string, type: string}> = [
        {
            "name": "result",
            "baseName": "result",
            "type": "Array<ModelVariantStats>"
        }    ];

    static getAttributeTypeMap() {
        return EvaluateJobResponseAllOf.attributeTypeMap;
    }
}

