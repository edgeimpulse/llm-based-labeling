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

import { ClassifySampleResponseClassification } from './classifySampleResponseClassification';
import { KerasModelVariantEnum } from './kerasModelVariantEnum';

export class ClassifySampleResponseVariantResults {
    'variant': KerasModelVariantEnum;
    'classifications': Array<ClassifySampleResponseClassification>;

    static discriminator: string | undefined = undefined;

    static attributeTypeMap: Array<{name: string, baseName: string, type: string}> = [
        {
            "name": "variant",
            "baseName": "variant",
            "type": "KerasModelVariantEnum"
        },
        {
            "name": "classifications",
            "baseName": "classifications",
            "type": "Array<ClassifySampleResponseClassification>"
        }    ];

    static getAttributeTypeMap() {
        return ClassifySampleResponseVariantResults.attributeTypeMap;
    }
}

